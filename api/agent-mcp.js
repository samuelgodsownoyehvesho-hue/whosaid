const MCP_VERSIONS = new Set(['2025-03-26', '2025-06-18', '2025-11-25']);
const LATEST_MCP_VERSION = '2025-11-25';
const GAME_API_ORIGIN = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://whosaid.vercel.app';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const ROOM_PATTERN = /^[A-Z0-9]{5}$/;

const tools = [
  {
    name: 'get_game_state',
    description: 'Read the current game observation, legal actions, players, and room status. Always call this before choosing a move.',
    inputSchema: {
      type: 'object',
      properties: { room: { type: 'string', pattern: '^[A-Z0-9]{5}$', description: 'Five-character room code from the invitation.' } },
      required: ['room'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_game_move',
    description: 'Submit one move exactly as it appears in the latest legalActions list. The server rejects moves that are not currently legal.',
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', pattern: '^[A-Z0-9]{5}$', description: 'Five-character room code from the invitation.' },
        move: { type: 'object', description: 'An exact legal action object returned by get_game_state.' },
      },
      required: ['room', 'move'],
      additionalProperties: false,
    },
  },
];

function jsonRpc(res, id, result, status = 200) {
  return res.status(status).json({ jsonrpc: '2.0', id, result });
}

function rpcError(res, id, code, message, status = 200) {
  return res.status(status).json({ jsonrpc: '2.0', id, error: { code, message } });
}

function toolResult(data, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], isError };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST for MCP JSON-RPC requests.' });

  const authorization = String(req.headers.authorization || '');
  const match = /^Bearer ([A-Za-z0-9_-]{32,128})$/.exec(authorization);
  if (!match || !TOKEN_PATTERN.test(match[1])) return res.status(401).json({ error: 'A valid room AI invite token is required.' });

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const id = body.id;
  if (body.jsonrpc !== '2.0' || typeof body.method !== 'string') {
    return rpcError(res, id === undefined ? null : id, -32600, 'Invalid JSON-RPC request.', 400);
  }

  if (body.method.startsWith('notifications/')) return res.status(202).end();
  if ((typeof id !== 'string' && typeof id !== 'number') || (typeof id === 'number' && !Number.isFinite(id))) {
    return rpcError(res, null, -32600, 'A JSON-RPC request id is required.', 400);
  }
  if (Buffer.byteLength(JSON.stringify(body)) > 8000) return res.status(413).json({ error: 'MCP request is too large.' });

  if (body.method === 'initialize') {
    const requestedVersion = String(body.params && body.params.protocolVersion || '');
    const protocolVersion = MCP_VERSIONS.has(requestedVersion) ? requestedVersion : LATEST_MCP_VERSION;
    return jsonRpc(res, id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'whosaid-game-player', version: '1.0.0' },
      instructions: 'Use get_game_state before every move. Submit only a move that exactly matches one item in legalActions. Room invites expire after six hours.',
    });
  }

  if (body.method === 'ping') return jsonRpc(res, id, {});
  if (body.method === 'tools/list') return jsonRpc(res, id, { tools });
  if (body.method !== 'tools/call') return rpcError(res, id, -32601, 'Method not found.');

  const params = body.params && typeof body.params === 'object' ? body.params : {};
  const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
  const room = String(args.room || '').toUpperCase();
  if (!ROOM_PATTERN.test(room)) return jsonRpc(res, id, toolResult({ error: 'Provide a valid five-character room code.' }, true));

  let upstreamUrl;
  let upstreamBody;
  if (params.name === 'get_game_state') {
    upstreamUrl = `${GAME_API_ORIGIN}/api/games?action=agent-state&code=${encodeURIComponent(room)}`;
  } else if (params.name === 'submit_game_move') {
    if (!args.move || typeof args.move !== 'object' || Array.isArray(args.move)) {
      return jsonRpc(res, id, toolResult({ error: 'move must be a legal action object from the latest game state.' }, true));
    }
    upstreamUrl = `${GAME_API_ORIGIN}/api/games`;
    upstreamBody = JSON.stringify({ action: 'agent-move', code: room, move: args.move });
  } else {
    return jsonRpc(res, id, toolResult({ error: 'Unknown tool.' }, true));
  }

  try {
    const response = await fetch(upstreamUrl, {
      method: upstreamBody ? 'POST' : 'GET',
      headers: { Authorization: authorization, ...(upstreamBody ? { 'Content-Type': 'application/json' } : {}) },
      ...(upstreamBody ? { body: upstreamBody } : {}),
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    return jsonRpc(res, id, toolResult(response.ok ? data : { error: data.error || 'The room request failed.' }, !response.ok));
  } catch (_) {
    return jsonRpc(res, id, toolResult({ error: 'The game service is temporarily unavailable.' }, true));
  }
};
