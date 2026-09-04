import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // The shared types package ships TypeScript source; let Next compile it.
  transpilePackages: ['@uhc/shared'],
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
