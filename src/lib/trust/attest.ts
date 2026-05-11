import type { TrustTier } from '@prisma/client';
import {
    Offchain,
    OffchainAttestationVersion,
    SchemaEncoder,
} from '@ethereum-attestation-service/eas-sdk';
import { Wallet, ZeroAddress, keccak256, toUtf8Bytes } from 'ethers';

/**
 * Result of attesting a trust score off-chain.
 *
 * `uid` is the EAS off-chain attestation UID (also recomputable client-side
 * from the signed payload). `signature` is the EIP-712 signature blob,
 * verifiable by anyone who knows the attester's public key and the schema.
 */
export interface AttestationResult {
    uid: string;
    signature: string;
    issuedAt: string;
}

export interface TrustAttestationPayload {
    affiliateId: string;
    score: number;
    tier: TrustTier;
    programId: string;
}

// Default to EAS on Polygon mainnet (cheap, broadly supported). Operators can
// override by setting EAS_CONTRACT_ADDRESS + EAS_CHAIN_ID for the chain
// their schema is registered on.
const DEFAULT_EAS_CONTRACT_ADDRESS = '0x5E634ef5355f45A855d02D66eCD687b1502AF790';
const DEFAULT_EAS_CHAIN_ID = 137;

const TIER_TO_UINT: Record<TrustTier, number> = {
    NEW: 0,
    BUILDING: 1,
    TRUSTED: 2,
    ELITE: 3,
};

/** Whether this environment is configured to write EAS attestations. */
export function isAttestationEnabled(): boolean {
    return (
        !!process.env.EAS_ATTESTER_PRIVATE_KEY &&
        !!process.env.EAS_SCHEMA_UID &&
        !!process.env.EAS_ATTESTATION_SALT
    );
}

function hashAffiliateId(affiliateId: string, salt: string): string {
    return keccak256(toUtf8Bytes(`${salt}:${affiliateId}`));
}

function hashProgramId(programId: string): string {
    return keccak256(toUtf8Bytes(`program:${programId}`));
}

/**
 * Sign and persist an off-chain EAS attestation for the given trust score.
 *
 * Off-chain attestations cost zero gas: they are EIP-712-signed JSON
 * payloads that anyone can verify with the attester's public key and the
 * registered schema UID. The schema itself (registered once on-chain via
 * the EAS UI) must declare the same field layout we encode below.
 *
 * Schema (register via https://easscan.org):
 *   bytes32 affiliateIdHash, uint16 score, uint8 tier, bytes32 programIdHash, uint64 computedAt
 *
 * If the env is not fully configured this returns `null` and the caller
 * leaves the TrustScore row's attestation fields null.
 */
export async function attestTrustScore(payload: TrustAttestationPayload): Promise<AttestationResult | null> {
    if (!isAttestationEnabled()) return null;

    const salt = process.env.EAS_ATTESTATION_SALT as string;
    const attesterKey = process.env.EAS_ATTESTER_PRIVATE_KEY as string;
    const schemaUid = process.env.EAS_SCHEMA_UID as string;
    const easContractAddress = process.env.EAS_CONTRACT_ADDRESS || DEFAULT_EAS_CONTRACT_ADDRESS;
    const chainId = process.env.EAS_CHAIN_ID
        ? parseInt(process.env.EAS_CHAIN_ID, 10)
        : DEFAULT_EAS_CHAIN_ID;
    if (!Number.isFinite(chainId)) {
        console.error('EAS_CHAIN_ID must be a number; falling back to default', DEFAULT_EAS_CHAIN_ID);
    }

    const issuedAt = new Date().toISOString();
    const computedAt = BigInt(Math.floor(Date.now() / 1000));
    const affiliateIdHash = hashAffiliateId(payload.affiliateId, salt);
    const programIdHash = hashProgramId(payload.programId);

    try {
        const wallet = new Wallet(attesterKey);

        const offchain = new Offchain(
            {
                address: easContractAddress,
                version: '1.2.0',
                chainId: BigInt(chainId),
            },
            OffchainAttestationVersion.Version2,
            // The EAS instance is only required when verifying on-chain refs;
            // for signing offchain we can omit it. Casting to unknown lets us
            // pass undefined where the type expects an EAS instance.
            undefined as unknown as never
        );

        const encoder = new SchemaEncoder(
            'bytes32 affiliateIdHash, uint16 score, uint8 tier, bytes32 programIdHash, uint64 computedAt'
        );
        const data = encoder.encodeData([
            { name: 'affiliateIdHash', value: affiliateIdHash, type: 'bytes32' },
            { name: 'score', value: payload.score, type: 'uint16' },
            { name: 'tier', value: TIER_TO_UINT[payload.tier], type: 'uint8' },
            { name: 'programIdHash', value: programIdHash, type: 'bytes32' },
            { name: 'computedAt', value: computedAt, type: 'uint64' },
        ]);

        const attestation = await offchain.signOffchainAttestation(
            {
                recipient: ZeroAddress,
                expirationTime: BigInt(0),
                time: computedAt,
                revocable: true,
                schema: schemaUid,
                refUID: '0x0000000000000000000000000000000000000000000000000000000000000000',
                data,
            },
            wallet
        );

        return {
            uid: attestation.uid,
            signature: JSON.stringify(attestation.signature),
            issuedAt,
        };
    } catch (err) {
        console.error('EAS attestation failed; leaving trust score unattested', err);
        return null;
    }
}
