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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { Gift, Plus, Pencil, Trash2 } from 'lucide-react';

type CreditType = 'INTERNAL_REFFERQ' | 'EXTERNAL_SAAS';
type TriggerType = 'MILESTONE_REFERRALS' | 'MILESTONE_EARNINGS' | 'MANUAL_ADMIN';
type CreditStatus = 'EARNED' | 'REDEEMED' | 'EXPIRED' | 'REVOKED';
type TrustTier = 'NEW' | 'BUILDING' | 'TRUSTED' | 'ELITE';

interface Bucket {
  id: string;
  name: string;
  description: string | null;
  creditType: CreditType;
  externalSaasName: string | null;
  externalSaasUrl: string | null;
  triggerType: TriggerType;
  triggerValue: number | null;
  expiresAfterDays: number | null;
  minTrustTier: TrustTier | null;
  isActive: boolean;
}

interface Earning {
  id: string;
  unlockCode: string;
  status: CreditStatus;
  earnedAt: string;
  redeemedAt: string | null;
  expiresAt: string | null;
  triggerNote: string | null;
  bucket: { id: string; name: string; creditType: CreditType; externalSaasName: string | null };
  affiliate: { id: string; referralCode: string; user: { email: string; name: string } };
}

interface BucketForm {
  name: string;
  description: string;
  creditType: CreditType;
  externalSaasName: string;
  externalSaasUrl: string;
  triggerType: TriggerType;
  triggerValue: string;
  expiresAfterDays: string;
  minTrustTier: TrustTier | 'NONE';
  isActive: boolean;
}

const emptyBucketForm: BucketForm = {
  name: '',
  description: '',
  creditType: 'EXTERNAL_SAAS',
  externalSaasName: '',
  externalSaasUrl: '',
  triggerType: 'MILESTONE_REFERRALS',
  triggerValue: '5',
  expiresAfterDays: '',
  minTrustTier: 'NONE',
  isActive: true,
};

function statusVariant(s: CreditStatus): 'default' | 'secondary' | 'destructive' {
  if (s === 'EARNED') return 'default';
  if (s === 'REDEEMED') return 'secondary';
  return 'destructive';
}

export default function AdminCreditsPage() {
  const [buckets, setBuckets] = useState<Bucket[]>([]);
  const [earnings, setEarnings] = useState<Earning[]>([]);
  const [loading, setLoading] = useState(true);
  const [bucketDialog, setBucketDialog] = useState(false);
  const [editingBucket, setEditingBucket] = useState<Bucket | null>(null);
  const [bucketForm, setBucketForm] = useState<BucketForm>(emptyBucketForm);
  const [savingBucket, setSavingBucket] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [b, e] = await Promise.all([
        fetch('/api/admin/credits/buckets').then((r) => r.json()),
        fetch('/api/admin/credits/earnings').then((r) => r.json()),
      ]);
      setBuckets(b.buckets ?? []);
      setEarnings(e.earnings ?? []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openCreateBucket = () => {
    setEditingBucket(null);
    setBucketForm(emptyBucketForm);
    setBucketDialog(true);
  };

  const openEditBucket = (b: Bucket) => {
    setEditingBucket(b);
    setBucketForm({
      name: b.name,
      description: b.description ?? '',
      creditType: b.creditType,
      externalSaasName: b.externalSaasName ?? '',
      externalSaasUrl: b.externalSaasUrl ?? '',
      triggerType: b.triggerType,
      triggerValue: String(b.triggerValue ?? ''),
      expiresAfterDays: b.expiresAfterDays !== null ? String(b.expiresAfterDays) : '',
      minTrustTier: b.minTrustTier ?? 'NONE',
      isActive: b.isActive,
    });
    setBucketDialog(true);
  };

  const saveBucket = async () => {
    setSavingBucket(true);
    try {
      const payload = {
        name: bucketForm.name,
        description: bucketForm.description || undefined,
        creditType: bucketForm.creditType,
        externalSaasName: bucketForm.creditType === 'EXTERNAL_SAAS' ? bucketForm.externalSaasName : undefined,
        externalSaasUrl: bucketForm.creditType === 'EXTERNAL_SAAS' && bucketForm.externalSaasUrl ? bucketForm.externalSaasUrl : undefined,
        triggerType: bucketForm.triggerType,
        triggerValue:
          bucketForm.triggerType === 'MANUAL_ADMIN'
            ? null
            : parseInt(bucketForm.triggerValue) || 0,
        expiresAfterDays: bucketForm.expiresAfterDays ? parseInt(bucketForm.expiresAfterDays) : null,
        minTrustTier: bucketForm.minTrustTier === 'NONE' ? null : bucketForm.minTrustTier,
        isActive: bucketForm.isActive,
      };
      const url = editingBucket
        ? `/api/admin/credits/buckets/${editingBucket.id}`
        : '/api/admin/credits/buckets';
      const res = await fetch(url, {
        method: editingBucket ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        await load();
        setBucketDialog(false);
        setEditingBucket(null);
        setBucketForm(emptyBucketForm);
      } else {
        const err = await res.json().catch(() => ({}));
        alert(typeof err.error === 'string' ? err.error : 'Failed to save bucket');
      }
    } finally {
      setSavingBucket(false);
    }
  };

  const deleteBucket = async (id: string) => {
    if (!confirm('Delete this bucket? If earnings exist it will be marked inactive instead.')) return;
    await fetch(`/api/admin/credits/buckets/${id}`, { method: 'DELETE' });
    await load();
  };

  const updateEarningStatus = async (id: string, status: CreditStatus) => {
    await fetch(`/api/admin/credits/earnings/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    await load();
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-[400px]" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Credits</h1>
        <p className="text-muted-foreground">SaaS credit buckets and the unlock codes affiliates have earned</p>
      </div>

      <Tabs defaultValue="buckets">
        <TabsList>
          <TabsTrigger value="buckets">Buckets ({buckets.length})</TabsTrigger>
          <TabsTrigger value="earnings">Earnings ({earnings.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="buckets" className="mt-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2"><Gift className="h-5 w-5" /> Credit Buckets</CardTitle>
                  <CardDescription>Define what affiliates can earn and how</CardDescription>
                </div>
                <Dialog open={bucketDialog} onOpenChange={setBucketDialog}>
                  <DialogTrigger asChild>
                    <Button onClick={openCreateBucket}><Plus className="mr-2 h-4 w-4" /> New Bucket</Button>
                  </DialogTrigger>
                  <DialogContent className="max-w-lg">
                    <DialogHeader>
                      <DialogTitle>{editingBucket ? 'Edit Bucket' : 'New Bucket'}</DialogTitle>
                      <DialogDescription>
                        Define the reward, its trigger, and any constraints
                      </DialogDescription>
                    </DialogHeader>
                    <div className="grid gap-3 py-2">
                      <div className="grid gap-2">
                        <Label>Name</Label>
                        <Input value={bucketForm.name} onChange={(e) => setBucketForm({ ...bucketForm, name: e.target.value })} placeholder="e.g. 1 Free Month" />
                      </div>
                      <div className="grid gap-2">
                        <Label>Description</Label>
                        <Input value={bucketForm.description} onChange={(e) => setBucketForm({ ...bucketForm, description: e.target.value })} placeholder="What does redeeming this unlock?" />
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-2">
                          <Label>Credit Type</Label>
                          <Select value={bucketForm.creditType} onValueChange={(v) => setBucketForm({ ...bucketForm, creditType: v as CreditType })}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="EXTERNAL_SAAS">External SaaS</SelectItem>
                              <SelectItem value="INTERNAL_REFFERQ">Refferq itself</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="grid gap-2">
                          <Label>Trigger</Label>
                          <Select value={bucketForm.triggerType} onValueChange={(v) => setBucketForm({ ...bucketForm, triggerType: v as TriggerType })}>
                            <SelectTrigger><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="MILESTONE_REFERRALS">N approved referrals</SelectItem>
                              <SelectItem value="MILESTONE_EARNINGS">$X approved earnings</SelectItem>
                              <SelectItem value="MANUAL_ADMIN">Manual (admin issues)</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      {bucketForm.creditType === 'EXTERNAL_SAAS' && (
                        <div className="grid grid-cols-2 gap-3">
                          <div className="grid gap-2">
                            <Label>External SaaS Name</Label>
                            <Input value={bucketForm.externalSaasName} onChange={(e) => setBucketForm({ ...bucketForm, externalSaasName: e.target.value })} placeholder="Acme CRM" />
                          </div>
                          <div className="grid gap-2">
                            <Label>External SaaS URL (optional)</Label>
                            <Input value={bucketForm.externalSaasUrl} onChange={(e) => setBucketForm({ ...bucketForm, externalSaasUrl: e.target.value })} placeholder="https://..." />
                          </div>
                        </div>
                      )}
                      <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-2">
                          <Label>Threshold {bucketForm.triggerType === 'MILESTONE_EARNINGS' ? '(cents)' : ''}</Label>
                          <Input
                            type="number"
                            min={0}
                            value={bucketForm.triggerValue}
                            onChange={(e) => setBucketForm({ ...bucketForm, triggerValue: e.target.value })}
                            disabled={bucketForm.triggerType === 'MANUAL_ADMIN'}
                          />
                        </div>
                        <div className="grid gap-2">
                          <Label>Expires After (days, optional)</Label>
                          <Input
                            type="number"
                            min={0}
                            value={bucketForm.expiresAfterDays}
                            onChange={(e) => setBucketForm({ ...bucketForm, expiresAfterDays: e.target.value })}
                            placeholder="Never expires"
                          />
                        </div>
                      </div>
                      <div className="grid gap-2">
                        <Label>Minimum Trust Tier</Label>
                        <Select value={bucketForm.minTrustTier} onValueChange={(v) => setBucketForm({ ...bucketForm, minTrustTier: v as TrustTier | 'NONE' })}>
                          <SelectTrigger><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="NONE">No gating</SelectItem>
                            <SelectItem value="NEW">NEW</SelectItem>
                            <SelectItem value="BUILDING">BUILDING</SelectItem>
                            <SelectItem value="TRUSTED">TRUSTED</SelectItem>
                            <SelectItem value="ELITE">ELITE</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex items-center gap-2">
                        <Switch checked={bucketForm.isActive} onCheckedChange={(v) => setBucketForm({ ...bucketForm, isActive: v })} />
                        <Label>Active</Label>
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setBucketDialog(false)}>Cancel</Button>
                      <Button onClick={saveBucket} disabled={savingBucket || !bucketForm.name}>
                        {savingBucket ? 'Saving...' : editingBucket ? 'Update' : 'Create'}
                      </Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {buckets.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                  <Gift className="h-10 w-10 opacity-50" />
                  <p className="mt-2">No buckets yet — create one to start rewarding affiliates.</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Trigger</TableHead>
                      <TableHead>Threshold</TableHead>
                      <TableHead>Min Tier</TableHead>
                      <TableHead>Active</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {buckets.map((b) => (
                      <TableRow key={b.id}>
                        <TableCell className="font-medium">{b.name}</TableCell>
                        <TableCell><Badge variant="outline">{b.creditType === 'INTERNAL_REFFERQ' ? 'Refferq' : (b.externalSaasName || 'External')}</Badge></TableCell>
                        <TableCell><Badge variant="outline">{b.triggerType.replace('MILESTONE_', '').replace('MANUAL_ADMIN', 'MANUAL').toLowerCase()}</Badge></TableCell>
                        <TableCell>{b.triggerType === 'MANUAL_ADMIN' ? '—' : b.triggerValue}</TableCell>
                        <TableCell>{b.minTrustTier ?? '—'}</TableCell>
                        <TableCell><Badge variant={b.isActive ? 'default' : 'secondary'}>{b.isActive ? 'Active' : 'Inactive'}</Badge></TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            <Button variant="ghost" size="icon" onClick={() => openEditBucket(b)}><Pencil className="h-4 w-4" /></Button>
                            <Button variant="ghost" size="icon" onClick={() => deleteBucket(b.id)}><Trash2 className="h-4 w-4 text-destructive" /></Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="earnings" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Earned Credits</CardTitle>
              <CardDescription>Every unlock code that&apos;s been issued</CardDescription>
            </CardHeader>
            <CardContent>
              {earnings.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
                  <Gift className="h-10 w-10 opacity-50" />
                  <p className="mt-2">No credits earned yet.</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Affiliate</TableHead>
                      <TableHead>Bucket</TableHead>
                      <TableHead>Unlock Code</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Earned</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {earnings.map((e) => (
                      <TableRow key={e.id}>
                        <TableCell>
                          <div className="font-medium">{e.affiliate?.user?.name ?? e.affiliate?.referralCode}</div>
                          <div className="text-xs text-muted-foreground">{e.affiliate?.user?.email}</div>
                        </TableCell>
                        <TableCell>{e.bucket.name}</TableCell>
                        <TableCell><code className="rounded bg-muted px-2 py-0.5 font-mono text-xs">{e.unlockCode}</code></TableCell>
                        <TableCell><Badge variant={statusVariant(e.status)}>{e.status}</Badge></TableCell>
                        <TableCell className="text-sm text-muted-foreground">{new Date(e.earnedAt).toLocaleDateString()}</TableCell>
                        <TableCell className="text-right">
                          <Select value={e.status} onValueChange={(v) => updateEarningStatus(e.id, v as CreditStatus)}>
                            <SelectTrigger className="ml-auto w-[130px]"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="EARNED">EARNED</SelectItem>
                              <SelectItem value="REDEEMED">REDEEMED</SelectItem>
                              <SelectItem value="EXPIRED">EXPIRED</SelectItem>
                              <SelectItem value="REVOKED">REVOKED</SelectItem>
                            </SelectContent>
                          </Select>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
