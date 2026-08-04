// Pure, UI-free chess rules engine + wire codec backing the "Play Chess" 1:1
// chat feature. Faithful port of iOS's ChessEngine.swift / ChessCodec (see
// KaChat/Utilities/ChessEngine.swift and KaChat/Models/Models.swift). Board
// state is never persisted directly — it's re-derived by replaying a game's
// move messages through this engine (see deriveBoard / stage-3 ChessGameService).
//
// Representation: squares[rank][file], rank 0 = board rank "1"; file 0 = "a".
// Piece = { type, color }; color "white"|"black"; type pawn|knight|bishop|rook|queen|king.

export const WHITE = "white";
export const BLACK = "black";
export const PIECE_GLYPHS = { king: "♚", queen: "♛", rook: "♜", bishop: "♝", knight: "♞", pawn: "♟︎" };

export function opposite(color) { return color === WHITE ? BLACK : WHITE; }

export function squareValid(sq) { return sq.file >= 0 && sq.file <= 7 && sq.rank >= 0 && sq.rank <= 7; }
export function sq(file, rank) { return { file, rank }; }
export function squareEquals(a, b) { return !!a && !!b && a.file === b.file && a.rank === b.rank; }

export function algebraic(square) {
  return String.fromCharCode(97 + square.file) + (square.rank + 1);
}
export function squareFromAlgebraic(text) {
  const s = String(text || "").toLowerCase();
  if (s.length !== 2) return null;
  const file = s.charCodeAt(0) - 97;
  const rank = Number(s[1]) - 1;
  if (file < 0 || file > 7 || !Number.isInteger(rank) || rank < 0 || rank > 7) return null;
  return { file, rank };
}

const PROMO_TO_LETTER = { queen: "q", rook: "r", bishop: "b", knight: "n" };
export function promotionLetter(type) { return PROMO_TO_LETTER[type] || null; }
export function promotionFromLetter(letter) {
  switch (String(letter || "").toLowerCase()) {
    case "q": return "queen";
    case "r": return "rook";
    case "b": return "bishop";
    case "n": return "knight";
    default: return null;
  }
}

export function initialBoard() {
  const squares = Array.from({ length: 8 }, () => Array(8).fill(null));
  const backRank = ["rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"];
  for (let file = 0; file < 8; file += 1) {
    squares[0][file] = { type: backRank[file], color: WHITE };
    squares[1][file] = { type: "pawn", color: WHITE };
    squares[6][file] = { type: "pawn", color: BLACK };
    squares[7][file] = { type: backRank[file], color: BLACK };
  }
  return {
    squares,
    sideToMove: WHITE,
    whiteCanCastleKingside: true,
    whiteCanCastleQueenside: true,
    blackCanCastleKingside: true,
    blackCanCastleQueenside: true,
    enPassantTarget: null,
  };
}

export function pieceAt(board, square) {
  if (!squareValid(square)) return null;
  return board.squares[square.rank][square.file];
}
function setPiece(board, piece, square) { board.squares[square.rank][square.file] = piece; }
function cloneBoard(board) {
  return {
    squares: board.squares.map((row) => row.slice()),
    sideToMove: board.sideToMove,
    whiteCanCastleKingside: board.whiteCanCastleKingside,
    whiteCanCastleQueenside: board.whiteCanCastleQueenside,
    blackCanCastleKingside: board.blackCanCastleKingside,
    blackCanCastleQueenside: board.blackCanCastleQueenside,
    enPassantTarget: board.enPassantTarget ? { ...board.enPassantTarget } : null,
  };
}
function canCastleKingside(board, color) { return color === WHITE ? board.whiteCanCastleKingside : board.blackCanCastleKingside; }
function canCastleQueenside(board, color) { return color === WHITE ? board.whiteCanCastleQueenside : board.blackCanCastleQueenside; }

const KNIGHT_OFFSETS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_OFFSETS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAGONALS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const STRAIGHTS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

function move(from, to, promotion = null) { return { from, to, promotion }; }
function moveKey(m) { return `${m.from.file},${m.from.rank}-${m.to.file},${m.to.rank}-${m.promotion || ""}`; }

// --- attack detection ---
export function isSquareAttacked(board, square, byColor) {
  const pawnRankOffset = byColor === WHITE ? -1 : 1;
  for (const fileOffset of [-1, 1]) {
    const from = sq(square.file + fileOffset, square.rank + pawnRankOffset);
    const p = pieceAt(board, from);
    if (p && p.type === "pawn" && p.color === byColor) return true;
  }
  for (const [df, dr] of KNIGHT_OFFSETS) {
    const p = pieceAt(board, sq(square.file + df, square.rank + dr));
    if (p && p.type === "knight" && p.color === byColor) return true;
  }
  for (const [df, dr] of KING_OFFSETS) {
    const p = pieceAt(board, sq(square.file + df, square.rank + dr));
    if (p && p.type === "king" && p.color === byColor) return true;
  }
  for (const [df, dr] of DIAGONALS) {
    if (slidingAttacker(board, square, df, dr, byColor, ["bishop", "queen"])) return true;
  }
  for (const [df, dr] of STRAIGHTS) {
    if (slidingAttacker(board, square, df, dr, byColor, ["rook", "queen"])) return true;
  }
  return false;
}
function slidingAttacker(board, square, df, dr, color, types) {
  let cur = sq(square.file + df, square.rank + dr);
  while (squareValid(cur)) {
    const p = pieceAt(board, cur);
    if (p) return p.color === color && types.includes(p.type);
    cur = sq(cur.file + df, cur.rank + dr);
  }
  return false;
}

function findKing(board, color) {
  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const p = board.squares[rank][file];
      if (p && p.type === "king" && p.color === color) return sq(file, rank);
    }
  }
  return null;
}
export function isKingInCheck(board, color) {
  const kingSquare = findKing(board, color);
  if (!kingSquare) return false;
  return isSquareAttacked(board, kingSquare, opposite(color));
}

// --- pseudo-legal move generation ---
function pawnMoves(color, square, board) {
  const moves = [];
  const direction = color === WHITE ? 1 : -1;
  const startRank = color === WHITE ? 1 : 6;
  const backRank = color === WHITE ? 7 : 0;
  const addMove = (to) => {
    if (!squareValid(to)) return;
    if (to.rank === backRank) {
      for (const promo of ["queen", "rook", "bishop", "knight"]) moves.push(move(square, to, promo));
    } else {
      moves.push(move(square, to, null));
    }
  };
  const singlePush = sq(square.file, square.rank + direction);
  if (squareValid(singlePush) && !pieceAt(board, singlePush)) {
    addMove(singlePush);
    const doublePush = sq(square.file, square.rank + direction * 2);
    if (square.rank === startRank && !pieceAt(board, doublePush)) moves.push(move(square, doublePush, null));
  }
  for (const fileOffset of [-1, 1]) {
    const target = sq(square.file + fileOffset, square.rank + direction);
    if (!squareValid(target)) continue;
    const occ = pieceAt(board, target);
    if (occ && occ.color !== color) addMove(target);
    else if (board.enPassantTarget && squareEquals(target, board.enPassantTarget)) moves.push(move(square, target, null));
  }
  return moves;
}
function steppingMoves(offsets, color, square, board) {
  const moves = [];
  for (const [df, dr] of offsets) {
    const target = sq(square.file + df, square.rank + dr);
    if (!squareValid(target)) continue;
    const occ = pieceAt(board, target);
    if (occ && occ.color === color) continue;
    moves.push(move(square, target, null));
  }
  return moves;
}
function slidingMoves(directions, color, square, board) {
  const moves = [];
  for (const [df, dr] of directions) {
    let target = sq(square.file + df, square.rank + dr);
    while (squareValid(target)) {
      const occ = pieceAt(board, target);
      if (occ) { if (occ.color !== color) moves.push(move(square, target, null)); break; }
      moves.push(move(square, target, null));
      target = sq(target.file + df, target.rank + dr);
    }
  }
  return moves;
}
function kingMoves(color, square, board) {
  const moves = steppingMoves(KING_OFFSETS, color, square, board);
  if (isSquareAttacked(board, square, opposite(color))) return moves;
  const rank = color === WHITE ? 0 : 7;
  const opp = opposite(color);
  if (canCastleKingside(board, color)
    && !pieceAt(board, sq(5, rank)) && !pieceAt(board, sq(6, rank))
    && !isSquareAttacked(board, sq(5, rank), opp) && !isSquareAttacked(board, sq(6, rank), opp)) {
    moves.push(move(square, sq(6, rank), null));
  }
  if (canCastleQueenside(board, color)
    && !pieceAt(board, sq(3, rank)) && !pieceAt(board, sq(2, rank)) && !pieceAt(board, sq(1, rank))
    && !isSquareAttacked(board, sq(3, rank), opp) && !isSquareAttacked(board, sq(2, rank), opp)) {
    moves.push(move(square, sq(2, rank), null));
  }
  return moves;
}
function pseudoLegalMoves(piece, square, board) {
  switch (piece.type) {
    case "pawn": return pawnMoves(piece.color, square, board);
    case "knight": return steppingMoves(KNIGHT_OFFSETS, piece.color, square, board);
    case "bishop": return slidingMoves(DIAGONALS, piece.color, square, board);
    case "rook": return slidingMoves(STRAIGHTS, piece.color, square, board);
    case "queen": return slidingMoves([...DIAGONALS, ...STRAIGHTS], piece.color, square, board);
    case "king": return kingMoves(piece.color, square, board);
    default: return [];
  }
}

// --- legal moves ---
export function legalMoves(board) {
  const pseudo = [];
  for (let rank = 0; rank < 8; rank += 1) {
    for (let file = 0; file < 8; file += 1) {
      const piece = board.squares[rank][file];
      if (!piece || piece.color !== board.sideToMove) continue;
      pseudo.push(...pseudoLegalMoves(piece, sq(file, rank), board));
    }
  }
  return pseudo.filter((m) => !isKingInCheck(applyMove(board, m), board.sideToMove));
}
export function legalMovesFrom(board, square) {
  return legalMoves(board).filter((m) => squareEquals(m.from, square));
}
export function normalizingPromotion(board, m) {
  if (m.promotion) return m;
  const piece = pieceAt(board, m.from);
  if (!piece || piece.type !== "pawn") return m;
  const backRank = piece.color === WHITE ? 7 : 0;
  if (m.to.rank !== backRank) return m;
  return move(m.from, m.to, "queen");
}
export function isLegalMove(board, m) {
  const normalized = normalizingPromotion(board, m);
  const key = moveKey(normalized);
  return legalMoves(board).some((lm) => moveKey(lm) === key);
}
export function isCheckmate(board) { return isKingInCheck(board, board.sideToMove) && legalMoves(board).length === 0; }
export function isStalemate(board) { return !isKingInCheck(board, board.sideToMove) && legalMoves(board).length === 0; }

// --- apply ---
export function applyMove(board, m) {
  const result = cloneBoard(board);
  const piece = pieceAt(result, m.from);
  if (!piece) return result;
  const isEnPassant = piece.type === "pawn" && board.enPassantTarget && squareEquals(m.to, board.enPassantTarget) && !pieceAt(result, m.to);
  const isCastle = piece.type === "king" && Math.abs(m.to.file - m.from.file) === 2;

  setPiece(result, null, m.from);
  setPiece(result, { type: m.promotion || piece.type, color: piece.color }, m.to);

  if (isEnPassant) setPiece(result, null, sq(m.to.file, m.from.rank));

  if (isCastle) {
    const rank = m.from.rank;
    if (m.to.file === 6) {
      setPiece(result, null, sq(7, rank));
      setPiece(result, { type: "rook", color: piece.color }, sq(5, rank));
    } else {
      setPiece(result, null, sq(0, rank));
      setPiece(result, { type: "rook", color: piece.color }, sq(3, rank));
    }
  }

  if (piece.type === "king") {
    if (piece.color === WHITE) { result.whiteCanCastleKingside = false; result.whiteCanCastleQueenside = false; }
    else { result.blackCanCastleKingside = false; result.blackCanCastleQueenside = false; }
  }
  revokeCastlingRightIfCornerTouched(result, m.from);
  revokeCastlingRightIfCornerTouched(result, m.to);

  if (piece.type === "pawn" && Math.abs(m.to.rank - m.from.rank) === 2) {
    result.enPassantTarget = sq(m.from.file, (m.from.rank + m.to.rank) / 2);
  } else {
    result.enPassantTarget = null;
  }
  result.sideToMove = opposite(board.sideToMove);
  return result;
}
function revokeCastlingRightIfCornerTouched(board, square) {
  if (square.file === 0 && square.rank === 0) board.whiteCanCastleQueenside = false;
  else if (square.file === 7 && square.rank === 0) board.whiteCanCastleKingside = false;
  else if (square.file === 0 && square.rank === 7) board.blackCanCastleQueenside = false;
  else if (square.file === 7 && square.rank === 7) board.blackCanCastleKingside = false;
}

// Convenience for the wire protocol: apply a move given algebraic squares. Returns the new board,
// or null if the move is illegal. Promotion defaults to queen for a back-rank pawn move.
export function applyAlgebraicMove(board, fromAlg, toAlg, promoLetter = null) {
  const from = squareFromAlgebraic(fromAlg);
  const to = squareFromAlgebraic(toAlg);
  if (!from || !to) return null;
  const m = normalizingPromotion(board, move(from, to, promotionFromLetter(promoLetter)));
  if (!isLegalMove(board, m)) return null;
  return applyMove(board, m);
}

// Replay a list of {from,to,promotion} algebraic moves from the initial position. Stops (returns
// what it has) at the first illegal move — mirrors how the game is rebuilt from move messages.
export function deriveBoard(moveList) {
  let board = initialBoard();
  for (const mv of moveList || []) {
    const next = applyAlgebraicMove(board, mv.from, mv.to, mv.promotion);
    if (!next) break;
    board = next;
  }
  return board;
}

// --- wire codec (JSON envelopes embedded as message content; matches iOS ChessCodec) ---
export function chessInvite(gameId, inviterColor) { return JSON.stringify({ type: "chess_invite", gameId, inviterColor }); }
export function chessResponse(gameId, accepted) { return JSON.stringify({ type: "chess_response", gameId, accepted }); }
export function chessMove(gameId, from, to, promotion = null) { return JSON.stringify({ type: "chess_move", gameId, from, to, promotion: promotion || null }); }
export function chessResign(gameId) { return JSON.stringify({ type: "chess_resign", gameId }); }

const CHESS_TYPES = { chess_invite: "invite", chess_response: "response", chess_move: "move", chess_resign: "resign" };
// Parses text as any chess envelope, or null. Cheap {-prefix + size guard first (runs per message).
export function parseChessEnvelope(text) {
  if (typeof text !== "string" || text.length >= 100000) return null;
  const trimmed = text.trim();
  if (trimmed[0] !== "{") return null;
  let parsed;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  const kind = parsed && CHESS_TYPES[parsed.type];
  if (!kind || typeof parsed.gameId !== "string") return null;
  return { kind, ...parsed };
}
export function isChessEnvelope(text) { return parseChessEnvelope(text) !== null; }

// If `text` is a reply-wrapped envelope ({type:"reply",...,text}), return the inner text so a
// chess envelope sent as a reply still parses. Otherwise returns text unchanged.
export function unwrapReplyText(text) {
  if (typeof text !== "string" || text.length >= 100000) return text;
  const trimmed = text.trim();
  if (trimmed[0] !== "{") return text;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && parsed.type === "reply" && typeof parsed.text === "string") return parsed.text;
  } catch { /* not JSON */ }
  return text;
}

// --- Game-state reconstruction (port of iOS ChessGameService.summarize/activeGame) ---
// `messages` items: { text, outgoing:boolean, txid:string, at:number }.

// Replays every chess envelope for `gameId` (in chronological order) and returns a summary, or
// null if no invite for that game is present.
export function summarizeChessGame(gameId, messages, myAddress, contactAddress) {
  let invite = null;
  let inviterAddress = null;
  let response = null;
  let resignerAddress = null;
  let lastTxid = "";
  let board = initialBoard();
  const moveHistory = [];

  const ordered = [...messages].sort((a, b) => (a.at || 0) - (b.at || 0));
  for (const msg of ordered) {
    const env = parseChessEnvelope(unwrapReplyText(msg.text));
    if (!env || env.gameId !== gameId) continue;
    lastTxid = msg.txid || lastTxid;
    const senderAddress = msg.outgoing ? myAddress : contactAddress;
    if (env.kind === "invite") {
      invite = env; inviterAddress = senderAddress;
    } else if (env.kind === "response") {
      response = env;
    } else if (env.kind === "move") {
      const from = squareFromAlgebraic(env.from);
      const to = squareFromAlgebraic(env.to);
      if (!from || !to) continue;
      const m = normalizingPromotion(board, move(from, to, promotionFromLetter(env.promotion)));
      if (!isLegalMove(board, m)) continue;
      const movingPiece = pieceAt(board, from);
      if (!movingPiece) continue;
      const isEnPassant = movingPiece.type === "pawn" && board.enPassantTarget && squareEquals(to, board.enPassantTarget) && !pieceAt(board, to);
      const captured = isEnPassant ? pieceAt(board, sq(to.file, from.rank)) : pieceAt(board, to);
      board = applyMove(board, m);
      moveHistory.push({
        from, to, pieceType: movingPiece.type, color: movingPiece.color,
        capturedType: captured ? captured.type : null,
        capturedColor: captured ? captured.color : null,
        promotion: m.promotion || null, messageTxid: msg.txid || "",
      });
    } else if (env.kind === "resign") {
      resignerAddress = senderAddress;
    }
  }

  if (!invite || !inviterAddress) return null;
  const otherAddress = inviterAddress === myAddress ? contactAddress : myAddress;
  const whiteAddress = invite.inviterColor === WHITE ? inviterAddress : otherAddress;
  const blackAddress = invite.inviterColor === WHITE ? otherAddress : inviterAddress;

  let status;
  if (resignerAddress) status = { kind: "resigned", loser: resignerAddress === whiteAddress ? WHITE : BLACK };
  else if (response && !response.accepted) status = { kind: "declined" };
  else if (!response) status = { kind: "pendingResponse" };
  else if (isCheckmate(board)) status = { kind: "checkmate", winner: opposite(board.sideToMove) };
  else if (isStalemate(board)) status = { kind: "stalemate" };
  else status = { kind: "inProgress" };

  const viewerColor = myAddress === whiteAddress ? WHITE : (myAddress === blackAddress ? BLACK : null);
  return {
    gameId, status, board, whiteAddress, blackAddress, inviterAddress,
    iAmInviter: inviterAddress === myAddress, viewerColor, moveHistory, lastTxid,
    capturedByWhite: moveHistory.filter((r) => r.color === WHITE && r.capturedType).map((r) => r.capturedType),
    capturedByBlack: moveHistory.filter((r) => r.color === BLACK && r.capturedType).map((r) => r.capturedType),
  };
}

export function isChessGameOver(status) {
  return status && (status.kind === "declined" || status.kind === "checkmate" || status.kind === "stalemate" || status.kind === "resigned");
}

// The contact's current active (not-yet-over) chess game, or null. Most recently invited wins.
export function activeChessGame(messages, myAddress, contactAddress) {
  const invites = messages
    .filter((m) => { const e = parseChessEnvelope(unwrapReplyText(m.text)); return e && e.kind === "invite"; })
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  const seen = new Set();
  for (const msg of invites) {
    const env = parseChessEnvelope(unwrapReplyText(msg.text));
    if (!env || seen.has(env.gameId)) continue;
    seen.add(env.gameId);
    const summary = summarizeChessGame(env.gameId, messages, myAddress, contactAddress);
    if (summary && !isChessGameOver(summary.status)) return summary;
  }
  return null;
}

// Cumulative wins/losses across every distinct game ever invited with this contact
// (checkmate + resignation count; stalemate/declined/pending/in-progress don't).
export function chessRecord(messages, myAddress, contactAddress) {
  const invites = messages.filter((m) => { const e = parseChessEnvelope(unwrapReplyText(m.text)); return e && e.kind === "invite"; });
  const seen = new Set();
  let wins = 0, losses = 0;
  for (const msg of invites) {
    const env = parseChessEnvelope(unwrapReplyText(msg.text));
    if (!env || seen.has(env.gameId)) continue;
    seen.add(env.gameId);
    const s = summarizeChessGame(env.gameId, messages, myAddress, contactAddress);
    if (!s || !s.viewerColor) continue;
    if (s.status.kind === "checkmate") { if (s.status.winner === s.viewerColor) wins += 1; else losses += 1; }
    else if (s.status.kind === "resigned") { if (s.status.loser === s.viewerColor) losses += 1; else wins += 1; }
  }
  return { wins, losses };
}

export function chessSummaryStatusText(summary) {
  const s = summary.status;
  const viewer = summary.viewerColor;
  switch (s.kind) {
    case "pendingResponse": return summary.iAmInviter ? "Waiting for response" : "Invited you to play";
    case "declined": return "Game declined";
    case "checkmate":
      if (!viewer) return `Checkmate — ${s.winner === WHITE ? "White" : "Black"} wins`;
      return s.winner === viewer ? "Checkmate — You win!" : "Checkmate — You lost";
    case "stalemate": return "Stalemate — draw";
    case "resigned":
      if (!viewer) return `${s.loser === WHITE ? "White" : "Black"} resigned`;
      return s.loser === viewer ? "You resigned" : "They resigned";
    case "inProgress":
    default: {
      const base = viewer ? (summary.board.sideToMove === viewer ? "Your turn" : "Their turn")
        : (summary.board.sideToMove === WHITE ? "White to move" : "Black to move");
      return isKingInCheck(summary.board, summary.board.sideToMove) ? `${base} — Check` : base;
    }
  }
}

// Short label for a chess message bubble/chat-list preview.
export function chessEnvelopeLabel(text) {
  const env = parseChessEnvelope(unwrapReplyText(text));
  if (!env) return null;
  switch (env.kind) {
    case "invite": return "Chess invite";
    case "response": return env.accepted ? "Chess accepted" : "Chess declined";
    case "move": return `Chess: ${env.from}→${env.to}`;
    case "resign": return "Chess resigned";
    default: return "Chess";
  }
}

let chessGameIdCounter = 0;
export function newGameId() {
  const rand = (typeof crypto !== "undefined" && crypto.getRandomValues)
    ? [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("")
    : Math.random().toString(16).slice(2);
  chessGameIdCounter += 1;
  return `g-${Date.now().toString(36)}-${rand}-${chessGameIdCounter}`;
}
