import { useMemo, useState } from 'react';

function fallbackCopyText(text) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) throw new Error('copy failed');
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  fallbackCopyText(text);
}

function getResponseMetaLines(responseMeta, rawText) {
  if (!responseMeta) return [];
  const lines = [];
  if (responseMeta.finishReason) lines.push(`响应结束原因：${responseMeta.finishReason}`);
  if (responseMeta.model) lines.push(`响应模型：${responseMeta.model}`);
  if (responseMeta.contentFormat) lines.push(`正文格式：${responseMeta.contentFormat}`);
  if (!rawText && responseMeta.hasReasoningContent) {
    lines.push('接口返回了推理内容，但没有最终正文；推理原文不会展示。');
  }
  if (responseMeta.completionTokens !== null && responseMeta.completionTokens !== undefined) {
    lines.push(`完成 token：${responseMeta.completionTokens}`);
  }
  return lines;
}

export default function AiResponseDiagnostics({ diagnostics }) {
  const [copyStatus, setCopyStatus] = useState('');
  const errors = Array.isArray(diagnostics?.errors) ? diagnostics.errors.filter(Boolean) : [];
  const rawText = typeof diagnostics?.rawText === 'string' ? diagnostics.rawText : '';
  const extractedText = typeof diagnostics?.extractedText === 'string' ? diagnostics.extractedText : '';
  const wasExtracted = !!extractedText && extractedText !== rawText.trim();
  const responseMetaLines = getResponseMetaLines(diagnostics?.responseMeta, rawText);
  const responseMetaText = responseMetaLines.join('\n');

  const errorText = useMemo(() => {
    const lines = [...errors];
    if (diagnostics?.parseError) lines.push(`JSON 解析器：${diagnostics.parseError}`);
    if (diagnostics?.parsedType && diagnostics.parsedType !== 'drafts') {
      lines.push(`解析到的顶层类型：${diagnostics.parsedType}`);
    }
    if (responseMetaText) lines.push(responseMetaText);
    return lines.join('\n');
  }, [diagnostics?.parseError, diagnostics?.parsedType, errors, responseMetaText]);

  if (!diagnostics || (!errors.length && !wasExtracted)) return null;

  const handleCopy = async (value, successMessage) => {
    try {
      await copyText(value);
      setCopyStatus(successMessage);
    } catch {
      setCopyStatus('复制失败，请在下方内容中手动选择复制。');
    }
  };

  return (
    <section className="ai-response-diagnostics" aria-live="polite">
      <div className={errors.length ? 'ai-draft-error' : 'ai-draft-warning'}>
        <strong className="ai-response-diagnostic-title">
          {errors.length ? 'AI 草稿不可用' : '已从 AI 返回内容中提取 JSON'}
        </strong>
        {errors.length > 0 && (
          <ul className="ai-response-error-list">
            {errors.map((error, index) => <li key={index}>{error}</li>)}
          </ul>
        )}
        {diagnostics.parseError && <div className="ai-response-parser-error">JSON 解析器：{diagnostics.parseError}</div>}
        {diagnostics.parsedType && diagnostics.parsedType !== 'drafts' && (
          <div className="ai-response-parser-error">解析到的顶层类型：{diagnostics.parsedType}</div>
        )}
        {errors.length > 0 && responseMetaLines.map((line, index) => (
          <div className="ai-response-parser-error" key={index}>
            {line}
          </div>
        ))}
        <div className="ai-response-actions">
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            disabled={!rawText}
            onClick={() => handleCopy(rawText, 'AI 原文已复制。')}
          >
            复制 AI 原文
          </button>
          {errors.length > 0 && (
            <button
              type="button"
              className="btn btn-sm btn-secondary"
              disabled={!errorText}
              onClick={() => handleCopy(errorText, '错误信息已复制。')}
            >
              复制错误信息
            </button>
          )}
        </div>
        {copyStatus && <div className="ai-response-copy-status" role="status">{copyStatus}</div>}
      </div>

      <details className="ai-response-details">
        <summary>查看 AI 原文</summary>
        <pre>{rawText || '（AI 返回为空）'}</pre>
      </details>

      {wasExtracted && (
        <details className="ai-response-details">
          <summary>查看提取后的 JSON 片段</summary>
          <pre>{extractedText}</pre>
        </details>
      )}
    </section>
  );
}
