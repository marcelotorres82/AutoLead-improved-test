import { isIP } from "node:net";
import { z } from "zod";

const privateHost =
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|::1$|fc|fd)/i;

export function assertSafePublicUrl(input: string) {
  const url = z.string().url().parse(input);
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Protocolo não permitido");
  if (
    privateHost.test(parsed.hostname) ||
    (isIP(parsed.hostname) && privateHost.test(parsed.hostname))
  )
    throw new Error("Destino privado não permitido");
  return parsed;
}

export function validOrigin(origin: string | null, hostHeader?: string | null): boolean {
  if (!origin) return true;
  try {
    const parsedOrigin = new URL(origin);
    const originHost = parsedOrigin.host.toLowerCase();
    const originHostname = parsedOrigin.hostname.toLowerCase();

    // Permitir requisições locais
    if (
      originHostname === "localhost" ||
      originHostname === "127.0.0.1" ||
      originHostname === "::1" ||
      originHostname.endsWith(".localhost")
    ) {
      return true;
    }

    // Permitir qualquer preview/deployment da Vercel para o projeto
    if (originHostname.endsWith(".vercel.app")) {
      return true;
    }

    // Permitir se corresponder ao header host da requisição (same-origin)
    if (hostHeader && (originHost === hostHeader.toLowerCase() || originHostname === hostHeader.toLowerCase())) {
      return true;
    }

    // Validar contra URLs configuradas no ambiente
    const allowedEnvUrls = [
      process.env.NEXT_PUBLIC_APP_URL,
      process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined,
      process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : undefined,
    ].filter(Boolean);

    for (const envUrl of allowedEnvUrls) {
      try {
        if (new URL(envUrl!).origin.toLowerCase() === parsedOrigin.origin.toLowerCase()) {
          return true;
        }
      } catch {
        // Ignorar URLs inválidas de ambiente
      }
    }

    return false;
  } catch {
    return false;
  }
}
