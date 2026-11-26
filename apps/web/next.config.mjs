/** @type {import('next').NextConfig} */
const nextConfig = {
  // db/client.ts runs the drizzle migrations from ./drizzle at first use; keep them in every serverless bundle.
  outputFileTracingIncludes: { "/**": ["./drizzle/**"] },
};

export default nextConfig;
