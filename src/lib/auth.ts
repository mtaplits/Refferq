// Authentication and session management for the affiliate platform
import { type User, Role, UserStatus } from '@prisma/client';
import { prisma } from '@/lib/prisma';
import * as bcrypt from 'bcryptjs';
import crypto from 'crypto';

export interface AuthSession {
  user: User;
  token: string;
  expiresAt: string;
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  name: string;
  role: string; // 'affiliate' or 'admin' from the form
  referrerCode?: string; // optional: referral code of the affiliate who recruited this one
}

const CYCLE_WALK_LIMIT = 20;

class AuthService {
  private readonly TOKEN_EXPIRY_HOURS = 24;

  private generateReferralCode(name: string): string {
    const cleanName = name.replace(/[^a-zA-Z]/g, '').toUpperCase();
    const random = crypto.randomBytes(3).toString('hex').toUpperCase().slice(0, 4);
    return `${cleanName.substr(0, 6)}-${random}`;
  }

  /**
   * Walk up the referrer's upline chain looking for `forbiddenAffiliateId`.
   * Used when wiring a `referredById` to detect/prevent cycles. The chain
   * walk is bounded at CYCLE_WALK_LIMIT to guard against pre-existing
   * corruption that we don't want to loop on.
   */
  private async chainContains(startAffiliateId: string, forbiddenAffiliateId: string): Promise<boolean> {
    let cursor: string | null = startAffiliateId;
    const visited = new Set<string>();
    let steps = 0;
    while (cursor && steps < CYCLE_WALK_LIMIT) {
      if (cursor === forbiddenAffiliateId) return true;
      if (visited.has(cursor)) return true; // pre-existing cycle in data; treat as forbidden
      visited.add(cursor);
      const row: { referredById: string | null } | null = await prisma.affiliate.findUnique({
        where: { id: cursor },
        select: { referredById: true },
      });
      cursor = row?.referredById ?? null;
      steps++;
    }
    return false;
  }

  /**
   * Register a new user and create their profile.
   * This is a server-side only method.
   */
  async register(data: RegisterData): Promise<{ success: boolean; message: string; user?: User }> {
    try {
      // Check if user already exists
      const existingUser = await prisma.user.findUnique({
        where: { email: data.email }
      });

      if (existingUser) {
        return { success: false, message: 'User already exists with this email' };
      }

      const userRoleLower = data.role.toLowerCase();

      // ─── Validate referrer code BEFORE creating user ───
      // We do this first so that an invalid referrer doesn't create a
      // half-registered user account.
      let referrer: { id: string; userId: string } | null = null;
      if (userRoleLower === 'affiliate' && data.referrerCode) {
        const found = await prisma.affiliate.findUnique({
          where: { referralCode: data.referrerCode },
          select: { id: true, userId: true },
        });
        if (!found) {
          return { success: false, message: 'Invalid referrer code' };
        }
        // Self-referral guard: ensure the referrer's user is not the same
        // person registering with a different email. We compare emails
        // because user records don't exist yet for the registrant.
        const referrerUser = await prisma.user.findUnique({
          where: { id: found.userId },
          select: { email: true },
        });
        if (referrerUser?.email?.toLowerCase() === data.email.toLowerCase()) {
          return { success: false, message: 'You cannot refer yourself' };
        }
        referrer = found;
      }

      // Hash password
      const hashedPassword = await bcrypt.hash(data.password, 12);

      // Determine initial status based on role
      const initialStatus = userRoleLower === 'admin' ? 'ACTIVE' : 'PENDING';

      // Create user using prisma client directly or db service
      const user = await prisma.user.create({
        data: {
          email: data.email,
          name: data.name,
          password: hashedPassword,
          role: data.role.toUpperCase() as Role,
          status: initialStatus as UserStatus
        }
      });

      // If affiliate, create affiliate record (with referrer wired if present)
      if (userRoleLower === 'affiliate') {
        const referralCode = this.generateReferralCode(data.name);

        const newAffiliate = await prisma.affiliate.create({
          data: {
            userId: user.id,
            referralCode,
            payoutDetails: {},
            balanceCents: 0,
            referredById: referrer?.id ?? null,
          }
        });

        // Defense in depth: after the row is created, verify no cycle was
        // introduced. The new affiliate has no downline at this point so a
        // true cycle is mathematically impossible — but if pre-existing data
        // is malformed (the referrer's upline already contains this new
        // affiliate via some race), null out referredById and continue.
        if (referrer && (await this.chainContains(referrer.id, newAffiliate.id))) {
          await prisma.affiliate.update({
            where: { id: newAffiliate.id },
            data: { referredById: null },
          });
        }
      }

      return {
        success: true,
        message: 'Registration successful',
        user: user
      };
    } catch (error) {
      console.error('Registration error:', error);
      return { success: false, message: 'Registration failed' };
    }
  }

  /**
   * Update a user's password.
   * Server-side only.
   */
  async updatePassword(userId: string, currentPassword: string, newPassword: string): Promise<{ success: boolean; message: string }> {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return { success: false, message: 'User not found' };
      }

      // Verify current password
      const isValidPassword = await bcrypt.compare(currentPassword, user.password);
      if (!isValidPassword) {
        return { success: false, message: 'Current password is incorrect' };
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 12);

      // Update password
      await prisma.user.update({
        where: { id: userId },
        data: { password: hashedPassword }
      });

      return { success: true, message: 'Password updated successfully' };
    } catch (error) {
      console.error('Update password error:', error);
      return { success: false, message: 'Password update failed' };
    }
  }
}

export const auth = new AuthService();