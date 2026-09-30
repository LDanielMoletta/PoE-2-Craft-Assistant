/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Paleta puxada do jogo: fundo quase preto, destaque em verde/laranja.
        poe: {
          900: '#0b0d10',
          800: '#12151a',
          700: '#1b1f26',
          600: '#2a3039',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
