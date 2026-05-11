import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    Offchain,
    OffchainAttestationVersion,
    SchemaEncoder,
} from '@ethereum-attestation-service/eas-sdk';
import { Wallet, ZeroAddress, keccak256, toUtf8Bytes } from 'ethers';
import { attestTrustScore, isAttestationEnabled } from '@/lib/trust/attest';

// Sepolia EAS contract address — the standard testnet target. Off-chain
// signing doesn't make any network calls, so we can use this purely as
// the EIP-712 domain seed without ever talking to Sepolia.
const SEPOLIA_EAS = '0xC2679fBD37d54388Ce493F1DB75320D236e1815e';
const SEPOLIA_CHAIN_ID = 11155111;
const TEST_SCHEMA_UID = '0x' + '1'.repeat(64);

/**
 * These tests prove the EAS SDK is wired correctly end-to-end:
 *  1. Direct SDK round-trip: sign an off-chain attestation with a generated
 *     wallet, then verify the EIP-712 signature with the SDK. This is what
 *     the public EAS verifier (easscan.org) would do for our attestations.
 *  2. attestTrustScore() wrapper: same flow through our code path, with the
 *     env vars set as they'd be in production.
 *
 * No on-chain calls are made. Operators wanting a true testnet smoke test
 * (post-attestations to easscan.org) just need to:
 *   - Register a schema on Sepolia at https://sepolia.easscan.org
 *   - Set EAS_SCHEMA_UID, EAS_CONTRACT_ADDRESS=<SEPOLIA_EAS above>,
 *     EAS_CHAIN_ID=11155111, EAS_ATTESTER_PRIVATE_KEY=<their key>,
 *     EAS_ATTESTATION_SALT=<random>
 *   - Call POST /api/admin/trust/recompute and look the UID up on easscan.
 */

describe('EAS attestation — direct SDK round trip', () => {
    it('signs an off-chain attestation that the SDK can verify with the right signer', async () => {
        const wallet = Wallet.createRandom();

        const offchain = new Offchain(
            { address: SEPOLIA_EAS, version: '1.2.0', chainId: BigInt(SEPOLIA_CHAIN_ID) },
            OffchainAttestationVersion.Version2,
            undefined as unknown as never
        );

        const encoder = new SchemaEncoder(
            'bytes32 affiliateIdHash, uint16 score, uint8 tier, bytes32 programIdHash, uint64 computedAt'
        );
        const data = encoder.encodeData([
            { name: 'affiliateIdHash', value: keccak256(toUtf8Bytes('test:aff-1')), type: 'bytes32' },
            { name: 'score', value: 750, type: 'uint16' },
            { name: 'tier', value: 2, type: 'uint8' }, // TRUSTED
            { name: 'programIdHash', value: keccak256(toUtf8Bytes('program:test')), type: 'bytes32' },
            { name: 'computedAt', value: BigInt(Math.floor(Date.now() / 1000)), type: 'uint64' },
        ]);

        const attestation = await offchain.signOffchainAttestation(
            {
                recipient: ZeroAddress,
                expirationTime: BigInt(0),
                time: BigInt(Math.floor(Date.now() / 1000)),
                revocable: true,
                schema: TEST_SCHEMA_UID,
                refUID: '0x' + '0'.repeat(64),
                data,
            },
            wallet
        );

        // Round-trip: the SDK can verify what it just signed.
        expect(attestation.uid).toMatch(/^0x[0-9a-f]{64}$/);
        const isValid = offchain.verifyOffchainAttestationSignature(wallet.address, attestation);
        expect(isValid).toBe(true);

        // A different signer's address must NOT verify.
        const otherAddress = Wallet.createRandom().address;
        const isValidForOther = offchain.verifyOffchainAttestationSignature(otherAddress, attestation);
        expect(isValidForOther).toBe(false);
    });
});

describe('attestTrustScore wrapper — Sepolia config', () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
        savedEnv = {
            EAS_ATTESTER_PRIVATE_KEY: process.env.EAS_ATTESTER_PRIVATE_KEY,
            EAS_SCHEMA_UID: process.env.EAS_SCHEMA_UID,
            EAS_ATTESTATION_SALT: process.env.EAS_ATTESTATION_SALT,
            EAS_CONTRACT_ADDRESS: process.env.EAS_CONTRACT_ADDRESS,
            EAS_CHAIN_ID: process.env.EAS_CHAIN_ID,
        };
    });

    afterEach(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('returns null when env is not fully configured', async () => {
        delete process.env.EAS_ATTESTER_PRIVATE_KEY;
        delete process.env.EAS_SCHEMA_UID;
        delete process.env.EAS_ATTESTATION_SALT;
        expect(isAttestationEnabled()).toBe(false);

        const res = await attestTrustScore({
            affiliateId: 'aff-1',
            score: 500,
            tier: 'TRUSTED',
            programId: 'prog-1',
        });
        expect(res).toBeNull();
    });

    it('returns a real EAS attestation when env is configured for Sepolia', async () => {
        const wallet = Wallet.createRandom();
        process.env.EAS_ATTESTER_PRIVATE_KEY = wallet.privateKey;
        process.env.EAS_SCHEMA_UID = TEST_SCHEMA_UID;
        process.env.EAS_ATTESTATION_SALT = 'test-salt-' + Math.random().toString(36).slice(2);
        process.env.EAS_CONTRACT_ADDRESS = SEPOLIA_EAS;
        process.env.EAS_CHAIN_ID = String(SEPOLIA_CHAIN_ID);
        expect(isAttestationEnabled()).toBe(true);

        const res = await attestTrustScore({
            affiliateId: 'aff-1',
            score: 850,
            tier: 'ELITE',
            programId: 'prog-1',
        });
        expect(res).not.toBeNull();
        expect(res!.uid).toMatch(/^0x[0-9a-f]{64}$/);
        // Signature is a JSON-stringified EIP-712 sig object — non-empty and parseable.
        expect(res!.signature.length).toBeGreaterThan(0);
        const sig = JSON.parse(res!.signature);
        // The exact shape varies across SDK versions, but the sig must contain
        // an r and s component (either flat fields or under a `signature` key).
        const hasComponents = (s: unknown): boolean => {
            if (!s || typeof s !== 'object') return false;
            const obj = s as Record<string, unknown>;
            return 'r' in obj || 'signature' in obj || 'compact' in obj;
        };
        expect(hasComponents(sig)).toBe(true);
        // issuedAt is a valid ISO timestamp.
        expect(() => new Date(res!.issuedAt).toISOString()).not.toThrow();
    });

    it('different affiliates produce different UIDs and signatures', async () => {
        const wallet = Wallet.createRandom();
        process.env.EAS_ATTESTER_PRIVATE_KEY = wallet.privateKey;
        process.env.EAS_SCHEMA_UID = TEST_SCHEMA_UID;
        process.env.EAS_ATTESTATION_SALT = 'shared-salt';
        process.env.EAS_CONTRACT_ADDRESS = SEPOLIA_EAS;
        process.env.EAS_CHAIN_ID = String(SEPOLIA_CHAIN_ID);

        const a = await attestTrustScore({
            affiliateId: 'aff-1',
            score: 500,
            tier: 'TRUSTED',
            programId: 'prog-1',
        });
        const b = await attestTrustScore({
            affiliateId: 'aff-2',
            score: 500,
            tier: 'TRUSTED',
            programId: 'prog-1',
        });
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect(a!.uid).not.toBe(b!.uid);
        expect(a!.signature).not.toBe(b!.signature);
    });
});
