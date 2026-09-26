export {
  AntigravityCLIOAuthPlugin,
  GoogleOAuthPlugin,
} from "./src/plugin";

export {
  authorizeAntigravity,
  exchangeAntigravity,
} from "./src/antigravity/oauth";

export type {
  AntigravityAuthorization,
  AntigravityTokenExchangeResult,
} from "./src/antigravity/oauth";

// OpenCode v2 entrypoint: default export with { id, setup }.
// V1 runtimes consume the named exports above; V2 requires this default
// export ("Plugin must export a default definition with an id and an
// effect or setup function" otherwise).
import AntigravityAuthV2Plugin from "./src/v2/index";
export default AntigravityAuthV2Plugin;
