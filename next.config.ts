import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfkit"],
  outputFileTracingIncludes: {
    "/reports/export": ["./public/eliot-logo.png", "./public/fonts/*.ttf"],
    "/reports/monthly/export": ["./public/eliot-logo.png", "./public/fonts/*.ttf"],
    "/admin/reports/export": ["./public/eliot-logo.png", "./public/fonts/*.ttf"],
  },
  outputFileTracingExcludes: {
    "/*": ["./.env", "./.env.*"],
  },
};

export default nextConfig;