'use strict';
/**
 * utils.js — Mail Header Encoding Repair Engine
 *
 * Design Principles (메일 시스템 엔지니어링 원칙):
 *
 * 1. DO NO HARM: 원문 유지 최우선.
 *    디코딩 결과가 더 나빠지면 포기하고 원문을 보존한다.
 *
 * 2. SINGLE EXIT: sanitize()는 단 하나의 출구점.
 *    모든 경로는 반드시 sanitize()를 통과해야 한다.
 *
 * 3. LOSSLESS FIRST: round-trip 검증으로 데이터 손실을 감지한다.
 *    UTF-8 decode → re-encode → 원본과 비교. 다르면 fallback.
 *
 * 4. NEVER RE-ENCODE AT DISPLAY: 리스트 표시 단계에서 재인코딩 금지.
 *    RFC2047 재인코딩은 발송(SMTP) 단계에서만 수행한다.
 *
 * 5. MAKE LOSS VISIBLE: 복구 불가능한 손실은 제거 대신 '?'로 표시한다.
 *    빈 문자열보다 "Fwd: OS1? (t?? ??)" 이 더 유용하다.
 */

const iconv = require('iconv-lite');

// ============================================================================
// SECTION 1: Charset Normalization
// ============================================================================

/**
 * Normalize RFC 2047 charset labels to iconv-lite compatible names.
 *
 * 한국 메일에서 자주 출현하는 잘못된 charset 표기 처리:
 * - ks_c_5601-1987  (Windows 한국어 메일에서 가장 흔함)
 * - euc-kr          (Linux/Unix 메일)
 * - iso-2022-kr     (오래된 시스템)
 * - ksc5601         (일부 비표준)
 */
function normalizeCharset(label) {
    if (!label) return 'utf-8';
    const c = label.toLowerCase().replace(/[\s_-]+/g, '').trim();

    if (c === 'ksc5601' || c === 'ksc56011987' || c === 'ksc5601987' ||
        c === 'euckr' || c === 'cseuckr' || c === 'iso2022kr' ||
        c === 'cp949' || c === 'windows949') return 'cp949';

    if (c === 'utf8' || c === 'utf-8') return 'utf-8';
    if (c === 'iso88591' || c === 'latin1') return 'latin1';
    if (c === 'windows1252' || c === 'cp1252') return 'cp1252';
    if (c === 'iso2022jp' || c === 'iso-2022-jp') return 'iso-2022-jp';
    if (c === 'shiftjis' || c === 'sjis' || c === 'shift_jis') return 'shift_jis';
    if (c === 'gb2312' || c === 'gbk' || c === 'gb18030') return 'gbk';

    return label.toLowerCase(); // pass-through for others
}

// ============================================================================
// SECTION 2: RFC 2047 Decoder
// ============================================================================

/**
 * Decode a single encoded-word payload to a Unicode string.
 *
 * 전략:
 * 1. 선언된 charset으로 먼저 시도
 * 2. UTF-8로 선언됐지만 \ufffd가 있으면 → "lossless round-trip" 검사
 *    - bytes → utf8 → bytes가 동일: 진짜 U+FFFD가 포함된 pre-corrupted 데이터.
 *      CP949 fallback 금지 (해봤자 占쏙옙만 나옴).
 *    - bytes → utf8 → bytes가 다름: invalid UTF-8 byte가 있음 = CP949 시도.
 */
function decodePayload(charset, encoding, combinedData) {
    // 1. Build raw bytes
    let buf;
    try {
        if (encoding.toUpperCase() === 'B') {
            buf = Buffer.from(combinedData.replace(/\s/g, ''), 'base64');
        } else { // Q encoding
            const qp = combinedData.replace(/_/g, ' ');
            const bytes = [];
            for (let i = 0; i < qp.length; i++) {
                if (qp[i] === '=' && i + 2 < qp.length) {
                    const h = qp.substring(i + 1, i + 3);
                    if (/^[0-9A-Fa-f]{2}$/.test(h)) {
                        bytes.push(parseInt(h, 16));
                        i += 2;
                    } else {
                        bytes.push(qp.charCodeAt(i));
                    }
                } else {
                    bytes.push(qp.charCodeAt(i) & 0xff);
                }
            }
            buf = Buffer.from(bytes);
        }
    } catch (e) {
        return null; // 파싱 실패: 원문 token 유지
    }

    const cs = normalizeCharset(charset);

    // 2. Attempt decode with declared charset
    try {
        const result = iconv.decode(buf, cs);

        if (!result.includes('\ufffd')) {
            return result; // 완벽한 디코딩
        }

        // \ufffd가 있다: 손실이 발생했음. 원인 파악.
        if (cs === 'utf-8') {
            // Lossless round-trip 검사
            // re-encode 결과가 원본과 같으면: 진짜 U+FFFD 포함 (pre-corrupted)
            // → CP949 fallback 시도 금지. 이 데이터는 복구 불가.
            if (Buffer.from(result, 'utf-8').equals(buf)) {
                return result; // 손실 표시 유지 (\ufffd → sanitize에서 '?'로 대체)
            }

            // round-trip 실패 → invalid UTF-8 bytes (CP949일 가능성)
            try {
                const cp949 = iconv.decode(buf, 'cp949');
                if (!cp949.includes('\ufffd')) return cp949;
            } catch (_) { /* ignore */ }
        }

        return result; // \ufffd 포함이더라도 선언 charset 결과 반환
    } catch (e) {
        return null;
    }
}

/**
 * Full RFC 2047 header decoder.
 *
 * RFC 2047 §6.2 핵심 규칙 구현:
 * - encoded-word 사이의 whitespace-only run은 무시한다 (결합).
 * - 같은 charset의 인접 encoded-word는 하나의 버퍼로 결합 후 디코딩한다.
 *   (멀티바이트 문자가 단어 경계에서 쪼개지는 것을 방지)
 * - encoded-word와 일반 텍스트 사이의 공백은 유지한다.
 */
function decodeRFC2047(str) {
    if (!str || typeof str !== 'string' || !str.includes('=?')) return str;

    // Unfold RFC 2822 folded headers
    const unfolded = str.replace(/\r?\n[ \t]+/g, ' ');

    // Parse into TEXT and WORD tokens
    // Non-greedy [^?]* to avoid cross-word matching
    const tokenRe = /=\?([^?\s]+)\?([QB])\?([^?]*)\?=/gi;
    const parts = [];
    let pos = 0;
    let m;

    while ((m = tokenRe.exec(unfolded)) !== null) {
        if (m.index > pos) {
            parts.push({ type: 'T', val: unfolded.substring(pos, m.index) });
        }
        parts.push({
            type: 'W',
            charset: m[1],
            enc: m[2].toUpperCase(),
            data: m[3],
            raw: m[0],
        });
        pos = tokenRe.lastIndex;
    }
    if (pos < unfolded.length) {
        parts.push({ type: 'T', val: unfolded.substring(pos) });
    }
    if (parts.length === 0) return str;

    // Build output
    const out = [];
    let i = 0;

    while (i < parts.length) {
        const p = parts[i];

        if (p.type === 'T') {
            // RFC 2047 §6.2: whitespace-only between two encoded-words → discard
            const prevW = out.length > 0 && parts[i - 1]?.type === 'W';
            const nextW = parts[i + 1]?.type === 'W';
            if (prevW && nextW && /^\s+$/.test(p.val)) {
                i++;
                continue; // discard inter-word whitespace
            }
            out.push(p.val);
            i++;
            continue;
        }

        // WORD: collect adjacent same-charset-same-encoding words
        const group = [p];
        const csNorm = normalizeCharset(p.charset);

        while (true) {
            const gap = parts[i + 1]; // might be whitespace TEXT
            const nxt = parts[i + 2]; // might be next WORD

            const gapIsWS = gap?.type === 'T' && /^\s*$/.test(gap.val);
            const nxtSame = nxt?.type === 'W'
                && normalizeCharset(nxt.charset) === csNorm
                && nxt.enc.toUpperCase() === p.enc.toUpperCase();

            if (gapIsWS && nxtSame) {
                group.push(nxt);
                i += 2;
            } else {
                break;
            }
        }

        // Combine data fields (no whitespace between base64/qp chunks)
        const combined = group.map(g => g.data).join('');
        const decoded = decodePayload(p.charset, p.enc, combined);

        if (decoded !== null) {
            out.push(decoded);
        } else {
            // Decode failed: preserve original tokens
            out.push(group.map(g => g.raw).join(' '));
        }
        i++;
    }

    return out.join('');
}

// ============================================================================
// SECTION 3: Raw Header Charset Detection
// (헤더가 RFC 2047 미사용, raw 8-bit bytes로 전달된 경우)
// ============================================================================

// Well-known CP949 byte sequences for Korean common words
const CP949_SIGS = [
    Buffer.from([0xba, 0xc2, 0xb3, 0xbb, 0xbb, 0xea, 0xb6, 0xf3]), // 보낸 사람
    Buffer.from([0xb9, 0xde, 0xb4, 0xc2, 0xbb, 0xea, 0xb6, 0xf3]), // 받는 사람
    Buffer.from([0xc1, 0xa6, 0xba, 0xf1]),                           // 제비
    Buffer.from([0xb3, 0xaf, 0xc1, 0xa6]),                           // 날짜
    Buffer.from([0xbf, 0xc0, 0xb5, 0xce, 0xc4, 0xab]),              // 아이디
];

/**
 * Decode raw (non-encoded-word) binary header string.
 *
 * 처리 순서:
 * 1. 순수 ASCII → 변환 없이 반환
 * 2. CP949 시그니처 매치 → CP949 decode
 * 3. UTF-8 lossless round-trip → UTF-8 반환 (U+FFFD 포함 가능, 복구 포기)
 * 4. invalid UTF-8이면 → CP949 시도
 * 5. 모두 실패 → UTF-8 lossy (일부 \ufffd 포함)
 */
function decodeRawHeader(binaryStr) {
    const buf = Buffer.from(binaryStr, 'binary');

    // 1. Pure ASCII
    if (buf.every(b => b < 0x80)) return binaryStr;

    // 2. CP949 signature
    for (const sig of CP949_SIGS) {
        if (buf.indexOf(sig) !== -1) {
            try { return iconv.decode(buf, 'cp949'); } catch (_) { break; }
        }
    }

    // 3. UTF-8 lossless round-trip
    const utf8 = buf.toString('utf8');
    if (Buffer.from(utf8, 'utf8').equals(buf)) {
        // 원본 바이트가 정확히 UTF-8이다.
        // U+FFFD가 포함되어 있어도 이것이 "원문"이므로 그대로 반환.
        return utf8;
    }

    // 4. round-trip 실패 → invalid UTF-8, try CP949
    try {
        const cp949 = iconv.decode(buf, 'cp949');
        if (!cp949.includes('\ufffd')) return cp949;
    } catch (_) { /* ignore */ }

    // 5. Last resort
    return utf8;
}

// ============================================================================
// SECTION 4: Sanitize (단일 출구점)
// ============================================================================

/**
 * Sanitize a decoded header string for display.
 *
 * 정책:
 * - U+FFFD (upstream 손실) → '?' (손실 가시화, 빈 문자열 방지)
 * - 제어문자 \x00-\x1f (탭/LF/CR 제외) → 제거
 * - 잔류 RFC 2047 토큰 → 제거 (decode 실패한 경우)
 * - 연속 공백 → 단일 공백
 *
 * ⚠️ U+FFFD를 완전 제거하면 "Fwd: (DB t) i" 같은 의미없는 문자열이 남음.
 *    '?' 대체로 "Fwd: (DB? t??) i???" 형태 유지 → 어떤 정보가 손실됐는지 알 수 있음.
 */
function sanitize(str) {
    if (!str || typeof str !== 'string') return '';
    return str
        .replace(/\ufffd/g, '?')                               // 손실 가시화
        .replace(/[\ufffe\uffff]/g, '')                        // BOM 관련 제거
        .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '')        // 제어문자 제거
        .replace(/=\?[^\s?]+\?[QB]\?[^?]*\?=/gi, '')          // 잔류 encoded-word 제거
        .replace(/[ \t]+/g, ' ')                               // 공백 정규화
        .trim();
}

// ============================================================================
// SECTION 5: Main Entry Point
// ============================================================================

/**
 * Decode and sanitize an email header field (Subject, From name, To name).
 *
 * Input:
 * - Buffer: raw header bytes from IMAP (binary-safe)
 * - string: already-decoded or raw binary string
 *
 * Output: Clean, displayable Unicode string.
 *
 * 처리 순서:
 * 1. '=?' 포함 → RFC 2047 디코딩 (decodeRFC2047)
 * 2. '=?' 없음 → raw charset 감지 (decodeRawHeader)
 * 3. 항상 sanitize() 통과 후 반환
 */
const repairHeader = (input) => {
    if (!input) return '';

    // ── Case 1: Raw bytes Buffer (from getRaw / msg.headers) ──────────────
    // These are genuine binary bytes that need charset detection + RFC2047 decode.
    if (Buffer.isBuffer(input)) {
        const binaryStr = input.toString('binary');
        const decoded = binaryStr.includes('=?')
            ? decodeRFC2047(binaryStr)
            : decodeRawHeader(binaryStr);
        return sanitize(decoded);
    }

    // ── Case 2: String (from simpleParser / imapflow envelope) ────────────
    const str = String(input);

    // If it still has RFC2047 tokens (e.g. imapflow failed to decode EUC-KR),
    // run our decoder on it as-is (it's ASCII-safe, no binary conversion needed).
    if (str.includes('=?')) {
        return sanitize(decodeRFC2047(str));
    }

    // Already a decoded Unicode string (e.g. "황민규" from simpleParser).
    // DO NOT pass through Buffer.from(str, 'binary') — that truncates non-ASCII chars!
    // Just sanitize control chars and return.
    return sanitize(str);
};

// ============================================================================
// SECTION 6: Body / Literal MIME Decoder
// ============================================================================

/**
 * Decode body text that may contain literal (non-MIME) Quoted-Printable.
 *
 * 일부 포워딩 구현에서 본문에 QP 인코딩이 literal 텍스트로 삽입됨.
 * (예: "=EC=9D=B4=EB=A9=94=EC=9D=BC" 형태)
 */
const repairLiteralMime = (input) => {
    if (!input) return '';

    let text = Buffer.isBuffer(input) ? input.toString('binary') : String(input);

    // Strip embedded MIME sub-headers
    text = text.replace(/Content-(Type|Transfer-Encoding|Disposition):[^\r\n]+(\r?\n)*/gi, '');

    const qpCount = (text.match(/=[0-9A-F]{2}/gi) || []).length;

    if (qpCount > 2) {
        // Decode literal QP
        text = text
            .replace(/=\r?\n/g, '')       // soft breaks
            .replace(/=[ \t]+/g, '')
            .replace(/<=\s*\/([^>]+)>/gi, '</$1>'); // fix broken tags

        const bytes = [];
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '=' && i + 2 < text.length && /^[0-9A-F]{2}$/i.test(text.substring(i + 1, i + 3))) {
                bytes.push(parseInt(text.substring(i + 1, i + 3), 16));
                i += 2;
            } else {
                bytes.push(text.charCodeAt(i) & 0xff);
            }
        }
        text = decodeRawHeader(Buffer.from(bytes).toString('binary'));
    } else {
        text = decodeRawHeader(text);
    }

    return text;
};

// ============================================================================
// SECTION 7: Forward Subject Builder
// ============================================================================

/**
 * Build a safe "Fwd:" subject.
 *
 * 원칙:
 * - 이미 "Fwd:"/"Re:"로 시작하면 prefix 중복 방지
 * - ASCII-only subject → ASCII prefix 추가 (재인코딩 불필요)
 * - non-ASCII subject → =?UTF-8?B?...?= 로 전체 인코딩
 * - 이 함수는 SMTP 발송 시에만 사용, 리스트 표시에는 사용 불필요
 */
function buildForwardSubject(decodedSubject) {
    if (!decodedSubject) return 'Fwd:';

    const clean = sanitize(decodedSubject);
    if (/^(Fwd|FW|Re|AW|WG)\s*:/i.test(clean)) return clean;

    const prefixed = `Fwd: ${clean}`;

    // ASCII-only: no encoding needed
    if (/^[\x00-\x7f]*$/.test(prefixed)) return prefixed;

    // Encode as UTF-8 Base64 encoded-words (max 75 bytes per word per RFC 2047)
    const maxBytes = 45; // 45 raw bytes → 60 base64 chars, fits in 75 total
    const utf8Buf = Buffer.from(prefixed, 'utf-8');
    const words = [];
    for (let offset = 0; offset < utf8Buf.length; offset += maxBytes) {
        const chunk = utf8Buf.subarray(offset, offset + maxBytes);
        words.push(`=?UTF-8?B?${chunk.toString('base64')}?=`);
    }
    return words.join(' ');
}

// ============================================================================
// Exports
// ============================================================================

// Legacy compatibility aliases
const safeDecodeQP = repairLiteralMime;
const unmangleString = (s) => s;
const isLikelyMangled = (s) => typeof s === 'string' && s.includes('\ufffd');

module.exports = {
    repairHeader,
    repairLiteralMime,
    buildForwardSubject,
    sanitize,
    // legacy
    safeDecodeQP,
    unmangleString,
    isLikelyMangled,
};
