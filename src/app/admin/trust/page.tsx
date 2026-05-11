'use client';

import React, { useEffect, useState } from 'react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Award, RefreshCw, Loader2 } from 'lucide-react';

type TrustTier = 'NEW' | 'BUILDING' | 'TRUSTED' | 'ELITE';

interface TrustScoreRow {
  id: string;
  affiliateId: string;
  score: number;
  tier: TrustTier;
  attestationUid: string | null;
  lastComputedAt: string;
  affiliate: {
    id: string;
    referralCode: string;
    balanceCents: number;
    user: { email: string; name: string };
    _count: { commissions: number; downline: number };
  };
}

const TIER_COLOR: Record<TrustTier, string> = {
  NEW: 'bg-muted text-muted-foreground',
  BUILDING: 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-200',
  TRUSTED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200',
  ELITE: 'bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200',
};

export default function AdminTrustPage() {
  const [scores, setScores] = useState<TrustScoreRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [recomputingOne, setRecomputingOne] = useState<string | null>(null);
  const [filter, setFilter] = useState<'ALL' | TrustTier>('ALL');

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/trust${filter === 'ALL' ? '' : `?tier=${filter}`}`);
      const data = await res.json();
      setScores(data.scores ?? []);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const recomputeAll = async () => {
    if (!confirm('Recompute trust scores for every affiliate? This may take a few seconds.')) return;
    setRecomputing(true);
    try {
      const res = await fetch('/api/admin/trust/recompute', { method: 'POST' });
      if (res.ok) await load();
    } finally {
      setRecomputing(false);
    }
  };

  const recomputeOne = async (affiliateId: string) => {
    setRecomputingOne(affiliateId);
    try {
      const res = await fetch(`/api/admin/trust/recompute?affiliateId=${affiliateId}`, { method: 'POST' });
      if (res.ok) await load();
    } finally {
      setRecomputingOne(null);
    }
  };

  const tierCounts = scores.reduce<Record<TrustTier, number>>(
    (acc, s) => {
      acc[s.tier] += 1;
      return acc;
    },
    { NEW: 0, BUILDING: 0, TRUSTED: 0, ELITE: 0 }
  );

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Trust Scores</h1>
          <p className="text-muted-foreground">Per-affiliate trust tier, score, and EAS attestation status</p>
        </div>
        <Button onClick={recomputeAll} disabled={recomputing}>
          {recomputing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
          {recomputing ? 'Recomputing...' : 'Recompute All'}
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {(['NEW', 'BUILDING', 'TRUSTED', 'ELITE'] as TrustTier[]).map((t) => (
          <Card key={t}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-wider text-muted-foreground">{t}</p>
                  <p className="text-2xl font-bold">{tierCounts[t]}</p>
                </div>
                <div className={`rounded-md px-2 py-1 text-xs font-semibold ${TIER_COLOR[t]}`}>{t}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="flex items-center gap-2"><Award className="h-5 w-5" /> All Trust Scores</CardTitle>
              <CardDescription>Click an affiliate&apos;s row to recompute their score on the spot</CardDescription>
            </div>
            <Select value={filter} onValueChange={(v) => setFilter(v as 'ALL' | TrustTier)}>
              <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">All tiers</SelectItem>
                <SelectItem value="NEW">NEW</SelectItem>
                <SelectItem value="BUILDING">BUILDING</SelectItem>
                <SelectItem value="TRUSTED">TRUSTED</SelectItem>
                <SelectItem value="ELITE">ELITE</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10" />)}
            </div>
          ) : scores.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <Award className="h-10 w-10 opacity-50" />
              <p className="mt-2">No trust scores yet. Run a recompute to populate.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Affiliate</TableHead>
                  <TableHead>Tier</TableHead>
                  <TableHead>Score</TableHead>
                  <TableHead>Commissions</TableHead>
                  <TableHead>Downline</TableHead>
                  <TableHead>Attested</TableHead>
                  <TableHead>Last Computed</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {scores.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="font-medium">{s.affiliate.user.name}</div>
                      <div className="text-xs text-muted-foreground">{s.affiliate.user.email}</div>
                    </TableCell>
                    <TableCell>
                      <span className={`inline-block rounded-md px-2 py-1 text-xs font-semibold ${TIER_COLOR[s.tier]}`}>{s.tier}</span>
                    </TableCell>
                    <TableCell className="font-mono">{s.score}<span className="text-xs text-muted-foreground">/1000</span></TableCell>
                    <TableCell>{s.affiliate._count.commissions}</TableCell>
                    <TableCell>{s.affiliate._count.downline}</TableCell>
                    <TableCell>
                      {s.attestationUid ? <Badge variant="default">Yes</Badge> : <Badge variant="secondary">No</Badge>}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{new Date(s.lastComputedAt).toLocaleDateString()}</TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => recomputeOne(s.affiliate.id)}
                        disabled={recomputingOne === s.affiliate.id}
                      >
                        {recomputingOne === s.affiliate.id ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Recompute'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
