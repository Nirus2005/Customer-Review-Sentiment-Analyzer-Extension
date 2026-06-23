/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./popup.html",
    "./src/**/*.{js,jsx}",
  ],
  theme: {
    extend: {
      colors: {
        ink: "#003135",
        muted: "#024950",
        panel: "#ffffff",
        shell: "#F6FAFA",
        surface: "#E9F7F9",
        primary: {
          DEFAULT: "#003135",
          hover: "#024950",
          soft: "#DDF3F6",
        },
        accent: "#0FA4AF",
        contrast: "#964734",
      },
      boxShadow: {
        popup: "0 8px 22px rgba(0, 49, 53, 0.12)",
        bubble: "0 5px 12px rgba(0, 49, 53, 0.18)",
      },
    },
  },
  plugins: [],
};
