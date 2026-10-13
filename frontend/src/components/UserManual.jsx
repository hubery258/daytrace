import manualText from '../docs/user-manual.txt?raw';

export default function UserManual() {
  return (
    <details className="card user-manual">
      <summary className="card-header user-manual-summary">
        用户手册
        <svg className="user-manual-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="m9 6 6 6-6 6" />
        </svg>
      </summary>
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{manualText}</div>
    </details>
  );
}
