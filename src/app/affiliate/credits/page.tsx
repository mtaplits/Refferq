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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Gift, Copy, Check, CheckCircle2, AlertCircle, ExternalLink } from 'lucide-react';

interface Bucket {
  id: string;
  name: string;
  description: string | null;
  creditType: 'INTERNAL_REFFERQ' | 'EXTERNAL_SAAS';
  externalSaasName: string | null;
  externalSaasUrl: string | null;
}

interface CreditEarning {
  id: string;
  unlockCode: string;
  status: 'EARNED' | 'REDEEMED' | 'EXPIRED' | 'REVOKED';
  earnedAt: string;
  redeemedAt: string | null;
  expiresAt: string | null;
  triggerNote: string | null;
  bucket: Bucket;
}

function statusVariant(s: CreditEarning['status']): 'default' | 'secondary' | 'destructive' {
  if (s === 'EARNED') return 'default';
  if (s === 'REDEEMED') return 'secondary';
  return 'destructive';
}

export default function AffiliateCreditsPage() {
  const [earnings, setEarnings] = useState<CreditEarning[]>([]);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState<string | null>(null);
  const [redeeming, setRedeeming] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const load = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/affiliate/credits');
      const data = await res.json();
      setEarnings(data.earnings ?? []);
    } catch (e) {
      console.error('Failed to load credits', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const onCopy = async (code: string) => {
    await navigator.clipboard.writeText(code);
    setCopied(code);
    setTimeout(() => setCopied(null), 2000);
  };

  const onRedeem = async (e: CreditEarning) => {
    if (!confirm(`Mark "${e.bucket.name}" as redeemed?`)) return;
    setRedeeming(e.id);
    setNotice(null);
    try {
      const res = await fetch('/api/affiliate/credits/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ unlockCode: e.unlockCode }),
      });
      const data = await res.json();
      if (res.ok) {
        setNotice({ type: 'success', message: 'Credit marked as redeemed.' });
        await load();
      } else {
        setNotice({ type: 'error', message: data.error || 'Failed to redeem' });
      }
    } catch (err) {
      setNotice({ type: 'error', message: err instanceof Error ? err.message : 'Failed to redeem' });
    } finally {
      setRedeeming(null);
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-56" />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-32" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Credits</h1>
        <p className="text-muted-foreground">Earned rewards you can redeem with a unique unlock code</p>
      </div>

      {notice && (
        <Alert variant={notice.type === 'error' ? 'destructive' : 'default'}>
          {notice.type === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          <AlertDescription>{notice.message}</AlertDescription>
        </Alert>
      )}

      {earnings.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <Gift className="h-12 w-12 text-muted-foreground/50" />
            <h3 className="mt-4 text-lg font-semibold">No credits earned yet</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Hit a milestone (referrals, earnings, or trust tier) and your credits will appear here.
            </p>
          </CardContent>
        </Card>
      ) : (
        earnings.map((e) => (
          <Card key={e.id}>
            <CardHeader>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Gift className="h-4 w-4" />
                    {e.bucket.name}
                  </CardTitle>
                  <CardDescription>
                    {e.bucket.creditType === 'EXTERNAL_SAAS' && e.bucket.externalSaasName
                      ? `Redeem on ${e.bucket.externalSaasName}`
                      : 'Redeem on your Refferq plan'}
                    {e.triggerNote ? ` · ${e.triggerNote}` : ''}
                  </CardDescription>
                </div>
                <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-2">
                <code className="rounded bg-muted px-3 py-1.5 font-mono text-sm">{e.unlockCode}</code>
                <Button variant="outline" size="icon" onClick={() => onCopy(e.unlockCode)}>
                  {copied === e.unlockCode ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                </Button>
                {e.bucket.externalSaasUrl && (
                  <Button variant="outline" size="sm" asChild>
                    <a href={e.bucket.externalSaasUrl} target="_blank" rel="noreferrer">
                      Open <ExternalLink className="ml-1 h-3 w-3" />
                    </a>
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>Earned: {new Date(e.earnedAt).toLocaleDateString()}</span>
                {e.expiresAt && <span>Expires: {new Date(e.expiresAt).toLocaleDateString()}</span>}
                {e.redeemedAt && <span>Redeemed: {new Date(e.redeemedAt).toLocaleDateString()}</span>}
              </div>
              {e.status === 'EARNED' && (
                <Button
                  variant="default"
                  size="sm"
                  onClick={() => onRedeem(e)}
                  disabled={redeeming === e.id}
                >
                  {redeeming === e.id ? 'Marking...' : 'Mark as Redeemed'}
                </Button>
              )}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
