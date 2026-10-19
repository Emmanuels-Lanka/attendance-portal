import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["pdfkit"],
  outputFileTracingIncludes: {
    "/reports/export": ["./public/eml-company-logo.png", "./public/fonts/*.ttf", "./node_modules/pdfkit/js/standard-fonts/**/*.cjs"],
    "/reports/monthly/export": ["./public/eml-company-logo.png", "./public/fonts/*.ttf", "./node_modules/pdfkit/js/standard-fonts/**/*.cjs"],
    "/admin/reports/export": ["./public/eml-company-logo.png", "./public/fonts/*.ttf", "./node_modules/pdfkit/js/standard-fonts/**/*.cjs"],
  },
  outputFileTracingExcludes: {
    "/*": ["./.env", "./.env.*"],
  },
};

export default nextConfig;