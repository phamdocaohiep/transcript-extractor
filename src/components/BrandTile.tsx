/**
 * The brand mark: three transcript lines and a record dot on a rounded tile.
 *
 * Colours come from the `--te-tile*` tokens, so the tile inverts with the
 * theme (dark on light, light on dark) as the logo sheet specifies.
 */
export const BrandTile = () => (
  <div
    className="flex h-[34px] w-[34px] flex-shrink-0 items-center justify-center rounded-[10px]"
    style={{
      background: 'var(--te-tile)',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.25), 0 4px 10px rgba(0,0,0,0.18)',
    }}
    aria-hidden="true"
  >
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round">
      <path d="M5 7h14M5 12h10M5 17h7" stroke="var(--te-tile-lines)" />
      <circle cx="18" cy="17" r="2.5" fill="var(--te-tile-dot)" />
    </svg>
  </div>
);
