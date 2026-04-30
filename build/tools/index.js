import { register as registerCreatorStore } from "./creatorStore.js";
import { register as registerForumSearch } from "./forumSearch.js";
import { register as registerForumTaxonomy } from "./forumTaxonomy.js";
import { register as registerForumThread } from "./forumThread.js";
import { register as registerPlatformStatus } from "./platformStatus.js";
import { register as registerRobloxApi } from "./robloxApi.js";
import { register as registerRobloxDocs } from "./robloxDocs.js";
export function registerAllTools(server, ctx) {
    registerForumSearch(server, ctx);
    registerForumThread(server, ctx);
    registerForumTaxonomy(server, ctx);
    registerRobloxApi(server, ctx);
    registerRobloxDocs(server, ctx);
    registerPlatformStatus(server, ctx);
    registerCreatorStore(server, ctx);
}
//# sourceMappingURL=index.js.map