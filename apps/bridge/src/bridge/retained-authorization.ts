import type {
  NativeConversationStore,
  NativeDelivery,
} from "../persistence/native-conversation-store.js";
import { authorizeSlackIdentity, type AuthorizationPolicy } from "../slack/authorize.js";

export function isNativeDeliveryAuthorized(
  delivery: NativeDelivery,
  policy: AuthorizationPolicy,
): boolean {
  if (delivery.revokedAt !== undefined) return false;
  return authorizeSlackIdentity(delivery, policy, {
    directMessage: delivery.directMessage ?? delivery.channelId.startsWith("D"),
  }).authorized;
}

export function revokeUnauthorizedDeliveries(
  store: NativeConversationStore,
  policy: AuthorizationPolicy,
): number {
  return store.revokeUnauthorized((delivery) => isNativeDeliveryAuthorized(delivery, policy));
}
