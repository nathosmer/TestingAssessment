export const metadata = {
  title: 'Provident Assessment Platform',
  description: 'Financial Stewardship Assessment for Nonprofits',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link href="https://fonts.googleapis.com/css2?family=Goudy+Bookletter+1911&family=Montserrat:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
      </head>
      <body>{children}</body>
    </html>
  );
}
