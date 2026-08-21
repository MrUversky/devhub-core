import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const siteMetadata: Metadata = {
  title: "DevHub — Never lose track of what your agent shipped.",
  description: "Your coding agent can build and deploy it. DevHub preserves the operational context: what exists, where it runs, what’s current, and what to do next across laptops, servers, and clouds.",
  icons: {
    icon: [{ url: "/favicon.svg", type: "image/svg+xml", sizes: "any" }],
    shortcut: "/favicon.svg",
  },
  openGraph: {
    title: "DevHub — Never lose track of what your agent shipped.",
    description: "Git remembers the code. DevHub remembers how it runs.",
    siteName: "DevHub — The home for what you shipped",
    images: [{ url: "/og.png", width: 1733, height: 907, alt: "DevHub — Never lose track of what your agent shipped." }],
  },
  twitter: {
    card: "summary_large_image",
    title: "DevHub — Never lose track of what your agent shipped.",
    description: "Git remembers the code. DevHub remembers how it runs.",
    images: ["/og.png"],
  },
};

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost ?? requestHeaders.get("host") ?? "localhost:3000";
  const safeHost = /^[a-z0-9.-]+(?::\d+)?$/i.test(requestHost) ? requestHost : "localhost:3000";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : safeHost.startsWith("localhost") || safeHost.startsWith("127.0.0.1") ? "http" : "https";

  return {
    metadataBase: new URL(`${protocol}://${safeHost}`),
    ...siteMetadata,
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" id="top">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
