/*
 * kimaitray-keyhelper: reads and writes the Kimai API token in the macOS
 * keychain on behalf of KimaiTray Adversum.
 *
 * Why it exists: the keychain remembers "Always Allow" per program. Without
 * an Apple team ID, macOS identifies a program by the hash of its code, so
 * every new build of the app would be asked again. This helper is built once
 * and then never changes, so its permission lasts. The app (any build of it)
 * runs the helper and gets the token through a pipe.
 *
 * To keep that from opening the token to every program, the helper only
 * serves a parent process that is validly signed as the app itself: bundle
 * identifier io.adversum.kimaitray, signed with our certificate.
 *
 *   kimaitray-keyhelper get <account>      token to stdout
 *   kimaitray-keyhelper set <account>      token from stdin
 *   kimaitray-keyhelper delete <account>
 *
 * Exit codes: 0 done, 2 usage, 3 no such entry, 4 caller not trusted,
 * 5 keychain error. The service name is fixed; this is not a general
 * keychain tool.
 *
 * Keep this file stable. Every change produces a different binary, and macOS
 * asks for the keychain once more (see CLAUDE.md, "Code signing").
 */
#include <CoreFoundation/CoreFoundation.h>
#include <Security/Security.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#ifndef SIGNER_HASH
#error "Define SIGNER_HASH: SHA-1 of the signing certificate, lowercase hex."
#endif

#define SERVICE "io.adversum.kimaitray"
#define CALLER_REQUIREMENT \
  "identifier \"io.adversum.kimaitray\" and certificate leaf = H\"" SIGNER_HASH "\""
#define MAX_SECRET_BYTES (64 * 1024)

enum {
  EXIT_DONE = 0,
  EXIT_USAGE = 2,
  EXIT_NO_ENTRY = 3,
  EXIT_UNTRUSTED = 4,
  EXIT_KEYCHAIN = 5,
};

/* Whether the process that started us is the validly signed app. */
static int caller_is_trusted(void) {
  int trusted = 0;
  pid_t parent = getppid();
  CFNumberRef pid = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &parent);
  const void *keys[] = {kSecGuestAttributePid};
  const void *values[] = {pid};
  CFDictionaryRef attributes =
      CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                         &kCFTypeDictionaryValueCallBacks);
  SecCodeRef code = NULL;
  SecRequirementRef requirement = NULL;
  if (SecCodeCopyGuestWithAttributes(NULL, attributes, kSecCSDefaultFlags, &code) ==
          errSecSuccess &&
      SecRequirementCreateWithString(CFSTR(CALLER_REQUIREMENT), kSecCSDefaultFlags,
                                     &requirement) == errSecSuccess &&
      SecCodeCheckValidity(code, kSecCSDefaultFlags, requirement) == errSecSuccess) {
    trusted = 1;
  }
  if (requirement) CFRelease(requirement);
  if (code) CFRelease(code);
  CFRelease(attributes);
  CFRelease(pid);
  return trusted;
}

static CFMutableDictionaryRef entry_query(const char *account) {
  CFMutableDictionaryRef query = CFDictionaryCreateMutable(
      kCFAllocatorDefault, 0, &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
  CFStringRef account_value =
      CFStringCreateWithCString(kCFAllocatorDefault, account, kCFStringEncodingUTF8);
  CFDictionarySetValue(query, kSecClass, kSecClassGenericPassword);
  CFDictionarySetValue(query, kSecAttrService, CFSTR(SERVICE));
  if (account_value) {
    CFDictionarySetValue(query, kSecAttrAccount, account_value);
    CFRelease(account_value);
  }
  return query;
}

static int get_entry(const char *account) {
  CFMutableDictionaryRef query = entry_query(account);
  CFDictionarySetValue(query, kSecReturnData, kCFBooleanTrue);
  CFDictionarySetValue(query, kSecMatchLimit, kSecMatchLimitOne);
  CFTypeRef result = NULL;
  OSStatus status = SecItemCopyMatching(query, &result);
  CFRelease(query);
  if (status == errSecItemNotFound) return EXIT_NO_ENTRY;
  if (status != errSecSuccess || !result) {
    fprintf(stderr, "keychain read failed: %d\n", (int)status);
    return EXIT_KEYCHAIN;
  }
  CFDataRef data = (CFDataRef)result;
  size_t length = (size_t)CFDataGetLength(data);
  int written = fwrite(CFDataGetBytePtr(data), 1, length, stdout) == length;
  CFRelease(result);
  return written && fflush(stdout) == 0 ? EXIT_DONE : EXIT_KEYCHAIN;
}

static int delete_entry(const char *account) {
  CFMutableDictionaryRef query = entry_query(account);
  OSStatus status = SecItemDelete(query);
  CFRelease(query);
  if (status == errSecSuccess || status == errSecItemNotFound) return EXIT_DONE;
  fprintf(stderr, "keychain delete failed: %d\n", (int)status);
  return EXIT_KEYCHAIN;
}

static int set_entry(const char *account) {
  static UInt8 secret[MAX_SECRET_BYTES + 1];
  size_t length = fread(secret, 1, sizeof(secret), stdin);
  if (length == 0 || length > MAX_SECRET_BYTES) {
    fprintf(stderr, "token is empty or too long\n");
    return EXIT_USAGE;
  }
  CFDataRef data = CFDataCreate(kCFAllocatorDefault, secret, (CFIndex)length);
  memset(secret, 0, sizeof(secret));

  /* Change the entry in place; where that is refused, replace it. */
  CFMutableDictionaryRef query = entry_query(account);
  const void *keys[] = {kSecValueData};
  const void *values[] = {data};
  CFDictionaryRef change =
      CFDictionaryCreate(kCFAllocatorDefault, keys, values, 1, &kCFTypeDictionaryKeyCallBacks,
                         &kCFTypeDictionaryValueCallBacks);
  OSStatus status = SecItemUpdate(query, change);
  CFRelease(change);
  if (status != errSecSuccess) {
    if (status != errSecItemNotFound) SecItemDelete(query);
    CFDictionarySetValue(query, kSecAttrLabel, CFSTR(SERVICE));
    CFDictionarySetValue(query, kSecValueData, data);
    status = SecItemAdd(query, NULL);
  }
  CFRelease(query);
  CFRelease(data);
  if (status == errSecSuccess) return EXIT_DONE;
  fprintf(stderr, "keychain write failed: %d\n", (int)status);
  return EXIT_KEYCHAIN;
}

int main(int argc, char **argv) {
  if (argc != 3 || argv[2][0] == '\0') {
    fprintf(stderr, "usage: kimaitray-keyhelper get|set|delete <account>\n");
    return EXIT_USAGE;
  }
  if (!caller_is_trusted()) {
    fprintf(stderr, "caller is not KimaiTray Adversum\n");
    return EXIT_UNTRUSTED;
  }
  if (strcmp(argv[1], "get") == 0) return get_entry(argv[2]);
  if (strcmp(argv[1], "set") == 0) return set_entry(argv[2]);
  if (strcmp(argv[1], "delete") == 0) return delete_entry(argv[2]);
  fprintf(stderr, "unknown command\n");
  return EXIT_USAGE;
}
