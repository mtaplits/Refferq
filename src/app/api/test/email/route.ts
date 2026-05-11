import { NextRequest, NextResponse } from 'next/server';
import { emailService } from '@/lib/email';
import { prisma } from '@/lib/prisma';


// Only allow in development, or require admin auth in production
async function requireAdminOrDev(request: NextRequest): Promise<{ error?: string; status?: number }> {
  try {
    // Block entirely in production unless authenticated as admin
    const userId = request.headers.get('x-user-id')!;
    const user = await prisma.user.findUnique({
      where: { id: userId }
    });
    if (!user || user.role !== 'ADMIN') {
      return { error: 'Admin access required', status: 403 };
    }
    return {};
  } catch (_error) {
    return { error: 'Invalid token', status: 401 };
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminOrDev(request);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  try {
    // Test email functionality
    const result = await emailService.sendWelcomeEmail({
      name: 'Test User',
      email: 'test@example.com',
      role: 'affiliate',
      loginUrl: 'http://localhost:3000',
    });

    return NextResponse.json({
      success: true,
      message: 'Test email sent successfully',
      // emailId: result.emailId, // Property doesn't exist on result
    });
  } catch (error) {
    console.error('Test email error:', error);
    return NextResponse.json(
      { 
        success: false, 
        message: 'Failed to send test email',
      },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const auth = await requireAdminOrDev(request);
  if (auth.error) {
    return NextResponse.json({ error: auth.error }, { status: auth.status });
  }

  return NextResponse.json({
    success: true,
    message: 'Email test endpoint is working',
    config: {
      transport: process.env.POSTMARK_SERVER_TOKEN
        ? 'postmark'
        : process.env.RESEND_API_KEY
        ? 'resend'
        : 'none',
      postmarkFromAddress: process.env.POSTMARK_FROM_ADDRESS || null,
      postmarkMessageStream: process.env.POSTMARK_MESSAGE_STREAM || null,
      resendFromEmail: process.env.RESEND_FROM_EMAIL || null,
      environment: process.env.NODE_ENV,
    },
  });
}