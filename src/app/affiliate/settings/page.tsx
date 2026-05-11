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
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  User,
  Building2,
  Mail,
  Globe,
  CreditCard,
  Shield,
  CheckCircle2,
  AlertCircle,
  Key,
  Copy,
  Check,
  Coins,
} from 'lucide-react';

type TreasuryType = 'FIAT' | 'CRYPTO';

const EVM_ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const TRON_ADDR_RE = /^T[a-zA-Z0-9]{33}$/;

export default function SettingsPage() {
  const { user, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [notification, setNotification] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [referralCode, setReferralCode] = useState('');
  const [saving, setSaving] = useState(false);
  const [treasuryType, setTreasuryType] = useState<TreasuryType>('FIAT');

  const [settingsForm, setSettingsForm] = useState({
    name: '',
    company: '',
    email: '',
    country: 'India',
    paymentMethod: 'PayPal',
    paymentEmail: '',
    walletAddress: '',
  });

  useEffect(() => {
    if (!authLoading && user) loadProfile();
  }, [authLoading, user]);

  const loadProfile = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/affiliate/profile');
      const data = await res.json();
      if (data.success) {
        const pd = data.affiliate?.payoutDetails || {};
        const programTreasury: TreasuryType = (data.program?.treasuryType as TreasuryType) ?? 'FIAT';
        setTreasuryType(programTreasury);
        setReferralCode(data.affiliate?.referralCode || '');
        setSettingsForm({
          name: data.user?.name || user?.name || '',
          company: pd.company || '',
          email: data.user?.email || user?.email || '',
          country: pd.country || 'India',
          paymentMethod: pd.paymentMethod || (programTreasury === 'CRYPTO' ? 'USDT_ONCHAIN' : 'PayPal'),
          paymentEmail: pd.paymentEmail || data.user?.email || '',
          walletAddress: pd.walletAddress || '',
        });
      }
    } catch (error) {
      console.error('Failed to load profile:', error);
    } finally {
      setLoading(false);
    }
  };

  const walletInvalid =
    treasuryType === 'CRYPTO' &&
    settingsForm.walletAddress.length > 0 &&
    !EVM_ADDR_RE.test(settingsForm.walletAddress) &&
    !TRON_ADDR_RE.test(settingsForm.walletAddress);

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/affiliate/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsForm),
      });
      if (res.ok) {
        showNotification('success', 'Settings updated successfully!');
      } else {
        const data = await res.json();
        showNotification('error', data.error || 'Failed to update settings');
      }
    } catch (_e) {
      showNotification('error', 'An error occurred');
    } finally {
      setSaving(false);
    }
  };

  const handleGenerateCode = async () => {
    try {
      const res = await fetch('/api/affiliate/generate-code', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showNotification('success', 'Referral code generated!');
        loadProfile();
      } else {
        showNotification('error', 'Failed to generate code: ' + data.error);
      }
    } catch (_e) {
      showNotification('error', 'Failed to generate code');
    }
  };

  const copyCode = () => {
    navigator.clipboard.writeText(referralCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const showNotification = (type: 'success' | 'error', message: string) => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  if (authLoading || loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3].map((i) => <Skeleton key={i} className="h-48" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-3xl">
      {notification && (
        <Alert variant={notification.type === 'error' ? 'destructive' : 'default'}>
          {notification.type === 'success' ? <CheckCircle2 className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}
          <AlertDescription>{notification.message}</AlertDescription>
        </Alert>
      )}

      <div>
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">Manage your account and payment preferences</p>
      </div>

      {/* Referral Code */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Key className="h-4 w-4" />
            Referral Code
          </CardTitle>
          <CardDescription>Your unique referral identifier</CardDescription>
        </CardHeader>
        <CardContent>
          {referralCode ? (
            <div className="flex items-center gap-2">
              <Input readOnly value={referralCode} className="font-mono max-w-xs" />
              <Button variant="outline" size="icon" onClick={copyCode}>
                {copied ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">No referral code generated yet.</p>
              <Button onClick={handleGenerateCode}>Generate Code</Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Personal Details */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <User className="h-4 w-4" />
            Personal Details
          </CardTitle>
          <CardDescription>Manage your account information</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" /> Full Name
              </Label>
              <Input
                value={settingsForm.name}
                onChange={(e) => setSettingsForm({ ...settingsForm, name: e.target.value })}
                placeholder="John Doe"
              />
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5" /> Company
              </Label>
              <Input
                value={settingsForm.company}
                onChange={(e) => setSettingsForm({ ...settingsForm, company: e.target.value })}
                placeholder="Company Name"
              />
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5" /> Email
              </Label>
              <Input
                type="email"
                value={settingsForm.email}
                onChange={(e) => setSettingsForm({ ...settingsForm, email: e.target.value })}
                placeholder="john@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-1.5">
                <Globe className="h-3.5 w-3.5" /> Country
              </Label>
              <Select
                value={settingsForm.country}
                onValueChange={(v) => setSettingsForm({ ...settingsForm, country: v })}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="India">India</SelectItem>
                  <SelectItem value="USA">United States</SelectItem>
                  <SelectItem value="UK">United Kingdom</SelectItem>
                  <SelectItem value="Canada">Canada</SelectItem>
                  <SelectItem value="Australia">Australia</SelectItem>
                  <SelectItem value="Germany">Germany</SelectItem>
                  <SelectItem value="France">France</SelectItem>
                  <SelectItem value="Singapore">Singapore</SelectItem>
                  <SelectItem value="UAE">UAE</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Payment Details */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {treasuryType === 'CRYPTO' ? <Coins className="h-4 w-4" /> : <CreditCard className="h-4 w-4" />}
            Payment Details
          </CardTitle>
          <CardDescription>
            {treasuryType === 'CRYPTO'
              ? 'Your USDT wallet address — payouts are sent on-chain.'
              : 'Configure how you receive payouts.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {treasuryType === 'CRYPTO' ? (
            <div className="grid grid-cols-1 gap-4">
              <div className="space-y-2">
                <Label>Payment Method</Label>
                <Select
                  value={settingsForm.paymentMethod}
                  onValueChange={(v) => setSettingsForm({ ...settingsForm, paymentMethod: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USDT_ONCHAIN">USDT (on-chain)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Wallet Address</Label>
                <Input
                  value={settingsForm.walletAddress}
                  onChange={(e) => setSettingsForm({ ...settingsForm, walletAddress: e.target.value })}
                  placeholder="0x... (EVM) or T... (Tron)"
                  className={walletInvalid ? 'border-destructive' : ''}
                />
                {walletInvalid ? (
                  <p className="text-xs text-destructive">
                    Address format not recognized. Expected an EVM (0x + 40 hex chars) or Tron (T + 33 alphanumeric) address.
                  </p>
                ) : (
                  <p className="text-[10px] text-muted-foreground">
                    The chain is determined by the program operator (configured in <code>NOWPAYMENTS_USDT_NETWORK</code>). Use the wallet that matches that chain.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Payment Method</Label>
                <Select
                  value={settingsForm.paymentMethod}
                  onValueChange={(v) => setSettingsForm({ ...settingsForm, paymentMethod: v })}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PayPal">PayPal</SelectItem>
                    <SelectItem value="Bank Transfer">Bank Transfer</SelectItem>
                    <SelectItem value="Stripe">Stripe</SelectItem>
                    <SelectItem value="Wise">Wise</SelectItem>
                    <SelectItem value="Wire Transfer">Wire Transfer</SelectItem>
                    <SelectItem value="UPI">UPI</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Payment Email / Account</Label>
                <Input
                  value={settingsForm.paymentEmail}
                  onChange={(e) => setSettingsForm({ ...settingsForm, paymentEmail: e.target.value })}
                  placeholder="payment@example.com"
                />
              </div>
            </div>
          )}

          <Separator />

          <Alert>
            <Shield className="h-4 w-4" />
            <AlertDescription>
              {treasuryType === 'CRYPTO'
                ? 'Triple-check your wallet address. On-chain transfers cannot be reversed.'
                : 'Your payment information is encrypted and stored securely. We will never share your details with third parties.'}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex justify-end">
        <Button
          onClick={handleSave}
          disabled={saving || walletInvalid}
          className="min-w-[120px]"
        >
          {saving ? 'Saving...' : 'Save Changes'}
        </Button>
      </div>
    </div>
  );
}
