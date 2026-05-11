'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  IndianRupee,
  MousePointerClick,
  Target,
  Users,
  Copy,
  Check,
  Link,
  Plus,
  Loader2,
  Clock,
  CheckCircle2,
  AlertCircle,
  Ban,
  TrendingUp,
  ArrowRight,
  Banknote,
  Award,
  Gift,
  ExternalLink,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import NextLink from 'next/link';
import { formatCurrency as formatCurrencyLib } from '@/lib/currency';

type TrustTier = 'NEW' | 'BUILDING' | 'TRUSTED' | 'ELITE';

const TIER_RANGES: Record<TrustTier, string> = {
  NEW: '0-199',
  BUILDING: '200-499',
  TRUSTED: '500-799',
  ELITE: '800-1000',
};
const TIER_NEXT: Record<TrustTier, number | null> = {
  NEW: 200,
  BUILDING: 500,
  TRUSTED: 800,
  ELITE: null,
};
const TIER_COLOR: Record<TrustTier, string> = {
  NEW: 'text-muted-foreground bg-muted',
  BUILDING: 'text-blue-700 bg-blue-100 dark:text-blue-200 dark:bg-blue-950',
  TRUSTED: 'text-emerald-700 bg-emerald-100 dark:text-emerald-200 dark:bg-emerald-950',
  ELITE: 'text-amber-700 bg-amber-100 dark:text-amber-200 dark:bg-amber-950',
};

interface AffiliateStats {
  totalEarnings: number;
  pendingEarnings: number;
  totalClicks: number;
  totalLeads: number;
  totalReferredCustomers: number;
  totalConversions: number;
  conversionRate: number;
  referralLink: string;
  referralCode: string;
  currencySymbol: string;
  nextMaturesAt: string | null;
}

interface Referral {
  id: string;
  leadName: string;
  leadEmail: string;
  company?: string;
  estimatedValue: number;
  status: string;
  createdAt: string;
}

interface TrustInfo {
  score: number;
  tier: TrustTier;
  attestationUid: string | null;
}

export default function AffiliateDashboard() {
  const { user, loading: authLoading } = useAuth();
  const [stats, setStats] = useState<AffiliateStats | null>(null);
  const [referrals, setReferrals] = useState<Referral[]>([]);
  const [currencySymbol, setCurrencySymbol] = useState('₹');
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);
  const [trust, setTrust] = useState<TrustInfo | null>(null);
  const [trustEnabled, setTrustEnabled] = useState(true);
  const [treasuryType, setTreasuryType] = useState<'FIAT' | 'CRYPTO'>('FIAT');
  const [creditsAvailable, setCreditsAvailable] = useState(0);

  // Referral form state
  const [showSubmitModal, setShowSubmitModal] = useState(false);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitForm, setSubmitForm] = useState({
    leadName: '',
    leadEmail: '',
    estimatedValue: '0',
  });

  useEffect(() => {
    if (!authLoading && user) {
      loadDashboardData();
    }
  }, [authLoading, user]);

  const loadDashboardData = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/affiliate/profile');
      const data = await response.json();

      if (data.success) {
        setStats({
          totalEarnings: data.affiliate?.balanceCents || 0,
          pendingEarnings: data.stats?.pendingEarnings || 0,
          totalClicks: data.stats?.totalClicks || 0,
          totalLeads: data.referrals?.length || 0,
          totalReferredCustomers: data.referrals?.filter((r: any) => r.status === 'APPROVED').length || 0,
          totalConversions: data.stats?.totalConversions || 0,
          conversionRate: data.stats?.conversionRate || 0,
          referralLink: `${window.location.origin}/r/${data.affiliate?.referralCode}`,
          referralCode: data.affiliate?.referralCode || '',
          currencySymbol: data.currencySymbol || '₹',
          nextMaturesAt: data.stats?.nextMaturesAt || null,
        });
        setReferrals(data.referrals || []);
        setCurrencySymbol(data.currencySymbol || '₹');
        setTrust(data.trust || null);
        setTrustEnabled(data.program?.trustEnabled ?? true);
        setTreasuryType((data.program?.treasuryType as 'FIAT' | 'CRYPTO') ?? 'FIAT');
      }
      // Fetch credits count separately
      try {
        const cr = await fetch('/api/affiliate/credits');
        if (cr.ok) {
          const cd = await cr.json();
          const count = (cd.earnings ?? []).filter((e: { status: string }) => e.status === 'EARNED').length;
          setCreditsAvailable(count);
        }
      } catch {
        /* non-fatal */
      }
    } catch (error) {
      console.error('Failed to load dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleSubmitLead = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitLoading(true);

    try {
      const response = await fetch('/api/affiliate/referrals', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lead_name: submitForm.leadName,
          lead_email: submitForm.leadEmail,
          estimated_value: submitForm.estimatedValue,
        }),
      });

      const data = await response.json();

      if (data.success) {
        showNotification('success', 'Lead submitted successfully! Waiting for admin approval.');
        setShowSubmitModal(false);
        setSubmitForm({ leadName: '', leadEmail: '', estimatedValue: '0' });
        loadDashboardData();
      } else {
        showNotification('error', data.error || 'Failed to submit lead');
      }
    } catch (_e) {
      showNotification('error', 'An error occurred while submitting lead');
    } finally {
      setSubmitLoading(false);
    }
  };

  const handleGenerateCode = async () => {
    try {
      const response = await fetch('/api/affiliate/generate-code', { method: 'POST' });
      const data = await response.json();
      if (data.success) {
        window.location.reload();
      } else {
        showNotification('error', 'Failed to generate code: ' + data.error);
      }
    } catch (_e) {
      showNotification('error', 'Failed to generate code. Please try again.');
    }
  };

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  const copyToClipboard = (text: string, type: 'link' | 'code') => {
    navigator.clipboard.writeText(text);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
  };

  const formatDate = (date: string) =>
    new Date(date).toLocaleDateString('en-IN', { year: 'numeric', month: 'short', day: 'numeric' });

  // Centralized formatter handles fiat prefix (`$10.00`) and crypto suffix (`10.00 USDT`).
  const formatCurrency = (cents: number) => formatCurrencyLib(cents, currencySymbol);

  const getStatusBadge = (status: string) => {
    const map: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: React.ElementType }> = {
      APPROVED: { variant: 'default', icon: CheckCircle2 },
      COMPLETED: { variant: 'default', icon: CheckCircle2 },
      PAID: { variant: 'default', icon: CheckCircle2 },
      PENDING: { variant: 'secondary', icon: Clock },
      PROCESSING: { variant: 'secondary', icon: Loader2 },
      REJECTED: { variant: 'destructive', icon: Ban },
      FAILED: { variant: 'destructive', icon: AlertCircle },
    };
    const { variant, icon: Icon } = map[status] || { variant: 'outline' as const, icon: Clock };
    return (
      <Badge variant={variant} className="gap-1 text-xs">
        <Icon className="h-3 w-3" />
        {status}
      </Badge>
    );
  };

  if (authLoading || loading) {
    return <DashboardSkeleton />;
  }

  return (
    <div className="space-y-6">
      {/* Notification */}
      {notification && (
        <Alert variant={notification.type === 'error' ? 'destructive' : 'default'}>
          {notification.type === 'success' ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <AlertCircle className="h-4 w-4" />
          )}
          <AlertDescription>{notification.message}</AlertDescription>
        </Alert>
      )}

      {/* Commission Banner */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.2 }}
      >
        <Card className="bg-gradient-to-br from-emerald-600 via-teal-600 to-cyan-700 text-white border-0 shadow-lg overflow-hidden relative group">
          <div className="absolute inset-0 bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 blur-2xl -translate-x-full group-hover:translate-x-full" />
          <CardContent className="flex items-center justify-between p-6 relative z-10">
            <div className="flex items-center gap-5">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-white/20 backdrop-blur-md shadow-inner">
                <span className="text-2xl font-bold">{currencySymbol}</span>
              </div>
              <div>
                <p className="text-sm text-white/90 font-medium tracking-wide">Earn 20% commission on all paid customers</p>
                <p className="text-xl font-bold mt-1 tracking-tight">Start referring today and grow your wealth!</p>
              </div>
            </div>
            <Button variant="secondary" onClick={() => setShowSubmitModal(true)} className="gap-2 hidden sm:flex bg-white text-emerald-700 hover:bg-emerald-50 border-0 shadow-md transform transition hover:scale-105 active:scale-95">
              <Plus className="h-4 w-4" />
              Submit Lead
            </Button>
          </CardContent>
        </Card>
      </motion.div>

      {/* Stats */}
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        {[
          {
            label: 'Available Balance',
            value: formatCurrency(stats?.totalEarnings || 0),
            icon: Banknote,
            color: 'text-emerald-600',
            bg: 'bg-emerald-500/10',
            description: 'Ready for payout'
          },
          {
            label: 'Pending Balance',
            value: formatCurrency(stats?.pendingEarnings || 0),
            icon: Clock,
            color: 'text-amber-600',
            bg: 'bg-amber-500/10',
            description: stats?.nextMaturesAt
              ? `Next maturity: ${new Date(stats.nextMaturesAt).toLocaleDateString()}`
              : 'Held for refund period'
          },
          { label: 'Total Clicks', value: stats?.totalClicks || 0, icon: MousePointerClick, color: 'text-blue-600', bg: 'bg-blue-500/10' },
          { label: 'Total Leads', value: stats?.totalLeads || 0, icon: Target, color: 'text-rose-600', bg: 'bg-rose-500/10' },
          { label: 'Conv. Rate', value: `${stats?.conversionRate?.toFixed(1) || '0.0'}%`, icon: TrendingUp, color: 'text-violet-600', bg: 'bg-violet-500/10' },
          { label: 'Credits', value: creditsAvailable, icon: Gift, color: 'text-pink-600', bg: 'bg-pink-500/10', description: creditsAvailable > 0 ? 'Available to redeem' : 'Earn by hitting milestones' },
        ].map((stat, i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 + i * 0.1 }}
            whileHover={{ y: -5 }}
          >
            <Card className="glass-card border-0">
              <CardContent className="p-6">
                <div className="flex items-center gap-4">
                  <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${stat.bg} backdrop-blur-sm transition-transform group-hover:scale-110`}>
                    {stat.icon === Banknote ? (
                      <span className={`text-lg font-bold ${stat.color}`}>{currencySymbol}</span>
                    ) : (
                      <stat.icon className={`h-5 w-5 ${stat.color}`} />
                    )}
                  </div>
                  <div>
                    <p className={`text-2xl font-bold ${stat.color}`}>
                      {stat.value}
                    </p>
                    <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">{stat.label}</p>
                    {stat.description && (
                      <p className="text-[10px] text-muted-foreground/70 mt-0.5 italic">{stat.description}</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          </motion.div>
        ))}
      </div>

      {/* Trust Score (Feature E) */}
      {trustEnabled && (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Award className="h-4 w-4" />
                  Trust Score
                </CardTitle>
                <CardDescription>
                  Better track record = shorter holds, optional rate boosts, and premium credit eligibility
                </CardDescription>
              </div>
              <div className={`rounded-md px-3 py-1.5 text-sm font-semibold ${TIER_COLOR[(trust?.tier ?? 'NEW') as TrustTier]}`}>
                {trust?.tier ?? 'NEW'}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Score</p>
                <p className="text-2xl font-bold">{trust?.score ?? 0}<span className="text-sm text-muted-foreground">/1000</span></p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Tier range</p>
                <p className="text-sm font-medium">{TIER_RANGES[(trust?.tier ?? 'NEW') as TrustTier]}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-muted-foreground">Next tier</p>
                <p className="text-sm font-medium">
                  {TIER_NEXT[(trust?.tier ?? 'NEW') as TrustTier] !== null
                    ? `${Math.max(0, (TIER_NEXT[(trust?.tier ?? 'NEW') as TrustTier] as number) - (trust?.score ?? 0))} pts to go`
                    : 'Max tier — well done!'}
                </p>
              </div>
            </div>
            {treasuryType === 'CRYPTO' && trust?.attestationUid && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>EAS attestation:</span>
                <code className="rounded bg-muted px-2 py-0.5 font-mono">{trust.attestationUid.slice(0, 14)}…</code>
                <NextLink
                  href={`https://offchain.attest.sh/attestation/view/${trust.attestationUid}`}
                  target="_blank"
                  className="inline-flex items-center gap-1 text-primary hover:underline"
                >
                  View <ExternalLink className="h-3 w-3" />
                </NextLink>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Referral Links */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Link className="h-4 w-4" />
            Your Referral Links
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {!stats?.referralCode ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted mb-4">
                <Link className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="font-medium">No referral code found</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Generate your referral code to start earning commissions
              </p>
              <Button className="mt-4" onClick={handleGenerateCode}>
                Generate Referral Code
              </Button>
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <Label>Referral Link</Label>
                <div className="flex gap-2">
                  <Input readOnly value={stats?.referralLink || ''} className="font-mono text-sm" />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => copyToClipboard(stats?.referralLink || '', 'link')}
                  >
                    {copied === 'link' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Referral Code</Label>
                <div className="flex gap-2">
                  <Input readOnly value={stats?.referralCode || ''} className="font-mono text-sm" />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => copyToClipboard(stats?.referralCode || '', 'code')}
                  >
                    {copied === 'code' ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Recent Referrals */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-base">Recent Referrals</CardTitle>
            <CardDescription>Latest 5 referrals</CardDescription>
          </div>
          {referrals.length > 5 && (
            <Button variant="ghost" size="sm" asChild>
              <a href="/affiliate/referrals" className="gap-1">
                View All <ArrowRight className="h-3.5 w-3.5" />
              </a>
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {referrals.length === 0 ? (
            <EmptyState icon={Users} message="No referrals yet" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {referrals.slice(0, 5).map((ref) => (
                  <TableRow key={ref.id}>
                    <TableCell className="font-medium">{ref.leadName}</TableCell>
                    <TableCell className="text-muted-foreground">{ref.leadEmail}</TableCell>
                    <TableCell>{getStatusBadge(ref.status)}</TableCell>
                    <TableCell className="text-muted-foreground text-sm">{formatDate(ref.createdAt)}</TableCell>
                    <TableCell className="text-right font-semibold">
                      {`${currencySymbol}${(Number(ref.estimatedValue) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <div className="grid gap-4 sm:grid-cols-3">
        <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => window.location.href = '/affiliate/referrals'}>
          <CardContent className="p-5 flex items-center gap-3">
            <Users className="h-5 w-5 text-blue-600" />
            <div>
              <p className="font-medium">Manage Referrals</p>
              <p className="text-xs text-muted-foreground">View all your submissions</p>
            </div>
            <ArrowRight className="h-4 w-4 ml-auto text-muted-foreground" />
          </CardContent>
        </Card>
        <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => window.location.href = '/affiliate/reports'}>
          <CardContent className="p-5 flex items-center gap-3">
            <TrendingUp className="h-5 w-5 text-emerald-600" />
            <div>
              <p className="font-medium">View Reports</p>
              <p className="text-xs text-muted-foreground">Analyze your performance</p>
            </div>
            <ArrowRight className="h-4 w-4 ml-auto text-muted-foreground" />
          </CardContent>
        </Card>
        <Card className="hover:shadow-md transition-shadow cursor-pointer" onClick={() => window.location.href = '/affiliate/resources'}>
          <CardContent className="p-5 flex items-center gap-3">
            <Target className="h-5 w-5 text-violet-600" />
            <div>
              <p className="font-medium">Resources</p>
              <p className="text-xs text-muted-foreground">Marketing materials</p>
            </div>
            <ArrowRight className="h-4 w-4 ml-auto text-muted-foreground" />
          </CardContent>
        </Card>
      </div>

      {/* Submit Lead Modal */}
      <Dialog open={showSubmitModal} onOpenChange={setShowSubmitModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Submit Lead</DialogTitle>
            <DialogDescription>
              Enter the details below to submit a lead. Ensure all information is accurate for proper tracking.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleSubmitLead} className="space-y-4">
            <div className="space-y-2">
              <Label>Lead&apos;s Name *</Label>
              <Input
                required
                value={submitForm.leadName}
                onChange={(e) => setSubmitForm({ ...submitForm, leadName: e.target.value })}
                placeholder="Full name"
              />
            </div>
            <div className="space-y-2">
              <Label>Contact Email *</Label>
              <Input
                type="email"
                required
                value={submitForm.leadEmail}
                onChange={(e) => setSubmitForm({ ...submitForm, leadEmail: e.target.value })}
                placeholder="email@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label>Estimated Deal Size ({currencySymbol}) *</Label>
              <Input
                type="number"
                required
                value={submitForm.estimatedValue}
                onChange={(e) => setSubmitForm({ ...submitForm, estimatedValue: e.target.value })}
                placeholder="0"
              />
              <p className="text-xs text-muted-foreground">Type 0 if unsure</p>
            </div>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowSubmitModal(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={submitLoading}>
                {submitLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Submit Lead
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyState({ icon: Icon, message }: { icon: React.ElementType; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-12 text-center">
      <Icon className="h-10 w-10 text-muted-foreground/40 mb-3" />
      <p className="text-sm font-medium text-muted-foreground">{message}</p>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-20 w-full rounded-xl" />
      <Skeleton className="h-10 w-full max-w-md" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-5">
              <div className="flex items-center gap-3">
                <Skeleton className="h-10 w-10 rounded-lg" />
                <div>
                  <Skeleton className="h-7 w-20 mb-1" />
                  <Skeleton className="h-3 w-16" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <Card>
        <CardContent className="p-6 space-y-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
