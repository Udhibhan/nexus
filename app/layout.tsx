import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'mbot Delivery System',
  description: 'Factory autonomous delivery — EPP project',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
