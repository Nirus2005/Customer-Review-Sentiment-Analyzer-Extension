/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./popup.html",
    "./src/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#111111",
        muted: "#666666",
        panel: "#ffffff",
        shell: "#fafafa",
        surface: "#f5f5f5",
        primary: {
          DEFAULT: "#111111",
          hover: "#000000",
          soft: "#f4f4f5",
        },
        accent: "#111111",
        contrast: "#111111",
      },
      boxShadow: {
        popup: "0 10px 30px rgba(0, 0, 0, 0.08)",
        bubble: "0 4px 12px rgba(0, 0, 0, 0.08)",
      },
      keyframes: {
        indeterminate: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        }
      },
      animation: {
        indeterminate: 'indeterminate 1.5s infinite ease-in-out',
      }
    },
  },
  plugins: [],
};
