/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
