import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

const maintainedTypeScript = [
  "src/**/*.{ts,tsx}",
  "tests/frontend/**/*.{ts,tsx}",
  "vite.config.ts",
  "vitest.config.ts"
];

// npm run lint enforces a zero-warning baseline. Keep warnings visible during
// development, but do not accept them in the maintained repository.

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "release-artifacts/**",
      "src-tauri/gen/**",
      "src-tauri/target/**",
      ".release-envs/**",
      ".venv*/**",
      "venv/**",
      "**/__pycache__/**",
      ".cache/**",
      "cache/**",
      "logs/**",
      "work/**"
    ]
  },
  {
    files: maintainedTypeScript,
    ...js.configs.recommended
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    files: ["tests/frontend/**/*.{ts,tsx}"],
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    files: ["vite.config.ts", "vitest.config.ts"],
    languageOptions: {
      globals: globals.node
    }
  },
  ...tseslint.configs.recommended.map((config) => ({
    ...config,
    files: maintainedTypeScript
  })),
  {
    files: ["src/**/*.{ts,tsx}", "tests/frontend/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": reactHooks
    },
    rules: {
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/rules-of-hooks": "error"
    }
  },
  {
    files: maintainedTypeScript,
    linterOptions: {
      reportUnusedDisableDirectives: "error"
    },
    rules: {
      "no-debugger": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrors: "all",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
          varsIgnorePattern: "^_"
        }
      ]
    }
  }
);
