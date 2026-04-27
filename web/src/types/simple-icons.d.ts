declare module "@icons-pack/react-simple-icons/icons/*.mjs" {
  import type { ElementType } from "react";
  const Icon: ElementType<{ size?: number | string; color?: string; title?: string; className?: string }>;
  export default Icon;
}
