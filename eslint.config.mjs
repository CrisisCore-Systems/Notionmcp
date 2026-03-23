import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [".next/**", "coverage/**", "next-env.d.ts", "node_modules/**", "scripts/**"],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
];

export default config;
