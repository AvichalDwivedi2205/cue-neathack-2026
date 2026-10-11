import type { Metadata } from "next";
import { AuthKitProvider } from "@workos-inc/authkit-nextjs/components";
import { Inter, JetBrains_Mono, Instrument_Serif } from "next/font/google";
import "./globals.css";

const cueSans = Inter({
  variable: "--font-cue-sans",
  subsets: ["latin"],
});

const cueMono = JetBrains_Mono({
  variable: "--font-cue-mono",
  subsets: ["latin"],
});
const cueSerif = Instrument_Serif({
  variable: "--font-cue-serif",
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
});

export const metadata: Metadata = {
  title: "Cue",
  description: "Customer problems to verified fixes",
  icons: {
    icon: "/cue-icon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${cueSans.variable} ${cueMono.variable} ${cueSerif.variable}`}
      >
        <AuthKitProvider>{children}</AuthKitProvider>
      </body>
    </html>
  );
}
