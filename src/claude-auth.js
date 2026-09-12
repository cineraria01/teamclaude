const RECOVERY_OAUTH_PREFIX = 'teamclaude-local-recovery:';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function hasClaudeRecoveryMarker(authorization) {
  if (typeof authorization !== 'string') return false;
  return authorization.split(',').some(value =>
    /^bearer[ \t]+teamclaude-local-recovery:/i.test(value.trimStart()));
}

export function parseClaudeRecoveryAccount(authorization) {
  const bearerPrefix = `Bearer ${RECOVERY_OAUTH_PREFIX}`;
  if (typeof authorization !== 'string' || !authorization.startsWith(bearerPrefix)) {
    return null;
  }
  const encoded = authorization.slice(bearerPrefix.length);
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  const accountUuid = Buffer.from(encoded, 'base64url').toString('utf8');
  if (!accountUuid
      || Buffer.from(accountUuid, 'utf8').toString('base64url') !== encoded) {
    return null;
  }
  return accountUuid;
}

export function buildClaudeRecoveryEnv(baseEnv, accountUuid) {
  let baseUrl;
  try {
    baseUrl = new URL(baseEnv?.ANTHROPIC_BASE_URL);
  } catch {
    throw new Error('Claude recovery requires a loopback TeamClaude URL');
  }

  const isLoopback = baseUrl.protocol === 'http:'
    && LOOPBACK_HOSTS.has(baseUrl.hostname)
    && !baseUrl.username
    && !baseUrl.password
    && baseUrl.pathname === '/'
    && !baseUrl.search
    && !baseUrl.hash;
  if (!isLoopback) {
    throw new Error('Claude recovery requires a loopback TeamClaude URL');
  }
  if (typeof accountUuid !== 'string' || accountUuid.length === 0) {
    throw new Error('Claude recovery requires a selected account');
  }

  const recoveryEnv = { ...baseEnv };
  delete recoveryEnv.ANTHROPIC_API_KEY;
  delete recoveryEnv.CLAUDE_CODE_OAUTH_TOKEN;
  const encodedAccount = Buffer.from(accountUuid, 'utf8').toString('base64url');
  // This is a local proxy routing marker, not an Anthropic OAuth credential.
  // Presented as CLAUDE_CODE_OAUTH_TOKEN, Claude Code treats it as its login:
  // it disables the claude.ai connectors and gates Fable tool continuations on
  // local credits. As a bearer auth token it only reaches the proxy's
  // Authorization header, which is all the routing hint needs.
  recoveryEnv.ANTHROPIC_AUTH_TOKEN = RECOVERY_OAUTH_PREFIX + encodedAccount;
  return recoveryEnv;
}
