declare const SPOTUIFY_LICENSE_TEXT: string | undefined;
declare const SPOTUIFY_THIRD_PARTY_NOTICES_TEXT: string | undefined;

export function formatSoftwareLicenses(
  spotuifyLicense: string,
  thirdPartyNotices: string,
): string {
  const normalizedLicense = spotuifyLicense.replaceAll("\r\n", "\n").trim();
  const normalizedNotices = thirdPartyNotices.replaceAll("\r\n", "\n").trim();
  return [
    "spotuify license",
    "",
    normalizedLicense,
    "",
    normalizedNotices,
  ].join("\n");
}

export async function softwareLicenses(): Promise<string> {
  const [spotuifyLicense, thirdPartyNotices] = await Promise.all([
    typeof SPOTUIFY_LICENSE_TEXT === "string"
      ? SPOTUIFY_LICENSE_TEXT
      : Bun.file(new URL("../LICENSE", import.meta.url)).text(),
    typeof SPOTUIFY_THIRD_PARTY_NOTICES_TEXT === "string"
      ? SPOTUIFY_THIRD_PARTY_NOTICES_TEXT
      : Bun.file(new URL("../THIRD_PARTY_NOTICES.txt", import.meta.url)).text(),
  ]);

  return formatSoftwareLicenses(spotuifyLicense, thirdPartyNotices);
}
