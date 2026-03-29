/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        noc: {
          bg:     '#0a0a0a',
          panel:  '#111111',
          raised: '#161616',
          border: '#222222',
          green:  '#00ff88',
          yellow: '#ffcc00',
          red:    '#ff4444',
          blue:   '#4488ff',
          text:   '#e0e0e0',
          muted:  '#555555',
          dim:    '#888888',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', '"Fira Code"', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
}
