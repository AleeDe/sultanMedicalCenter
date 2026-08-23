/**
 * The board gets its own layout: no nav, no chrome.
 *
 * It runs unattended on a waiting-room TV where nothing is clickable, so
 * navigation would only take up space that belongs to the token numbers.
 */
export default function DisplayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <>{children}</>;
}
