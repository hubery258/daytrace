import { useState, useRef, useEffect } from 'react';

export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);

  useEffect(() => {
    const handler = (e) => {
      if (ref.current && !ref.current.contains(e.target)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  return (
    <div className="context-menu" style={{ left: x, top: y }} ref={ref}>
      {items.map((item, i) => (
        <div
          key={i}
          className={`context-menu-item ${item.danger ? 'danger' : ''}`}
          onClick={() => { item.onClick(); onClose(); }}
        >
          {item.label}
        </div>
      ))}
    </div>
  );
}
