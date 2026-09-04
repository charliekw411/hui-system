/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/**/*.{astro,html,js,jsx,md,mdx,ts,tsx}'],
  theme: {
    extend: {
      colors: {
        forest: {
          DEFAULT: '#1a3a2a',
          dark: '#122a1e',
          light: '#2a5440',
        },
        gold: {
          DEFAULT: '#c8a96e',
          dark: '#a8884e',
        },
        cream: {
          DEFAULT: '#f5f0e8',
          dark: '#e8e0d2',
        },
      },
      fontFamily: {
        heading: ['"Playfair Display"', 'serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
