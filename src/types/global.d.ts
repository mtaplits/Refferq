declare namespace NodeJs {
    interface ProcessEnv {
        JWT_SECRET: string;
        DATABASE_URL: string;
        // Set exactly one transactional-email provider. Postmark wins when both are set.
        POSTMARK_SERVER_TOKEN?: string;
        POSTMARK_FROM_ADDRESS?: string;
        POSTMARK_MESSAGE_STREAM?: string;
        RESEND_API_KEY?: string;
        RESEND_FROM_EMAIL?: string;
        NEXT_PUBLIC_APP_URL: string;
    }
}

declare var process: {
    env: NodeJs.ProcessEnv;
};
