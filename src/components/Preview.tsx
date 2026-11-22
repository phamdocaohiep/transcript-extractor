import { useEffect, useState } from 'react';

export function Preview({
  url,
  thumbnail,
  title,
}: {
  url?: string;
  thumbnail?: string;
  title: string;
}) {
  let source = thumbnail;
  try {
    const address = new URL(url || '');
    if (/(^|\.)youtube\.com$/.test(address.hostname)) {
      const id = address.searchParams.get('v') || address.pathname.match(/^\/shorts\/([^/]+)/)?.[1];
      if (id) source = `https://i.ytimg.com/vi/${encodeURIComponent(id)}/mqdefault.jpg`;
    }
  } catch {
    /* No source-page preview. */
  }
  try {
    const address = new URL(source || '');
    if (address.protocol !== 'https:' || address.username || address.password) source = undefined;
  } catch {
    source = undefined;
  }
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [source]);
  if (!source || failed) return null;
  return (
    <img
      className="te-preview"
      src={source}
      alt={`Preview: ${title}`}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
