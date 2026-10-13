import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import { Nav } from "@/components/Nav";
import { Footer } from "@/components/Footer";
import { MotionInit } from "@/components/MotionInit";
import SignalField from "@/components/SignalField";
import "./globals.css";
import styles from "./layout.module.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"], weight: ["300", "400", "500", "600"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"], weight: ["400", "500"] });
const instrumentSerif = Instrument_Serif({ variable: "--font-instrument-serif", subsets: ["latin"], weight: "400", style: ["italic", "normal"] });

export const metadata: Metadata = {
  title: {
    default: "CompliR - Counterparty risk oracle on Arc. Compiled to signed verdicts.",
    template: "%s · CompliR",
  },
  description:
    "Grade any counterparty in one call. Signed EIP-712 verdicts a contract can check, mirrored on-chain, re-graded continuously, replayable from a hash-chained log. Never holds funds.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f4ef" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0b0d" },
  ],
};

/** Runs before paint: applies the persisted theme (`complir.theme`) so there is no flash. */
const THEME_INIT = `(function(){try{var t=localStorage.getItem("complir.theme");if(t==="light"||t==="dark"){document.documentElement.setAttribute("data-theme",t)}}catch(e){}})();`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} ${instrumentSerif.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <SignalField />
        <MotionInit />
        <Nav />
        <main className={styles.main}>{children}</main>
        <Footer />
      </body>
    </html>
  );
}
