import { PublicInvitationScreen } from "@/features/calendar/PublicInvitationScreen";

/**
 * An invitation's page (`/i/?t=<token>`): someone invited by address answers it here, without an
 * account. A page of its own, exported like the others, so it needs no session and loads none of the
 * app.
 */
export default function Invitation() {
  return <PublicInvitationScreen />;
}
