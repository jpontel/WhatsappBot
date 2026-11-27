// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

export default tseslint.config(
    {
        ignores: [
            'node_modules',
            'dist',
            'auth_info_baileys',
            'temp_videos',
            'temp_audio',
            // Vestígios de implementações antigas (CommonJS, não carregam sob o ESM/NodeNext
            // atual) — documentados como tal em whatsapp-bot/CLAUDE.md, sem importadores.
            'src/config/whatsapp.client.js',
            'src/config/baileys.client.ts',
            'src/services/craft.service.ts',
            'src/services/heavy.service.ts',
        ],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            // Strictness principal já vem do tsconfig.json (strict, noUncheckedIndexedAccess etc).
            '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
            '@typescript-eslint/no-explicit-any': 'warn',
            'no-console': 'off',
        },
    },
    eslintConfigPrettier,
);
