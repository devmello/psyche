// Vitest setup file: fail any test whose model-visible captures leak a secret. See vitest.ts.
import { installSecretLeakGuard } from "./vitest.ts";

installSecretLeakGuard();
