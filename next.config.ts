import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Allow the dev server to accept requests proxied through ngrok tunnels
  allowedDevOrigins: ["*.ngrok-free.app", "*.ngrok.app", "*.ngrok.io"],

  // Origins allowed to embed this app as an <iframe> (embedded mode). Browsers
  // block framing unless the framed document opts in via CSP `frame-ancestors`,
  // so list YOUR host app's exact origins here — preview and production origins
  // usually differ; include both. The Lovable origins below are an example from
  // the first deployment (editor shell, in-editor preview, published app).
  // Embedding hosts must ALSO be listed in NEXT_PUBLIC_ALLOWED_PARENT_ORIGINS
  // for postMessage to be accepted (see docs/embedding-guide.md).
  // We deliberately do NOT send `X-Frame-Options` — it predates and conflicts
  // with `frame-ancestors` (it has no multi-origin syntax), and modern browsers
  // honour the CSP directive.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors 'self' https://lovable.dev https://*.lovableproject.com https://*.lovable.app",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
