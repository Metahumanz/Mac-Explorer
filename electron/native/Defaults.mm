#import <AppKit/AppKit.h>
#import <ServiceManagement/ServiceManagement.h>
#include <node_api.h>
#include <string>

// Login-item plumbing runs inside the app process:
// SMAppService registers the app itself, so a helper binary could only register the helper.

static napi_value BoolValue(napi_env env, BOOL value) {
  napi_value result;
  napi_get_boolean(env, value, &result);
  return result;
}

static napi_value Text(napi_env env, NSString *value) {
  napi_value result;
  if (!value) { napi_get_null(env, &result); return result; }
  napi_create_string_utf8(env, value.UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}

static void Fail(napi_env env, NSString *message) {
  napi_throw_error(env, nullptr, message ? message.UTF8String : "Unknown error");
}

static napi_value AppURL(napi_env env, napi_callback_info info) {
  return Text(env, NSBundle.mainBundle.bundleURL.path);
}

static napi_value BundleID(napi_env env, napi_callback_info info) {
  return Text(env, NSBundle.mainBundle.bundleIdentifier);
}

static napi_value LoginEnabled(napi_env env, napi_callback_info info) {
  if (@available(macOS 13.0, *)) return BoolValue(env, SMAppService.mainAppService.status == SMAppServiceStatusEnabled);
  return BoolValue(env, NO);
}

static napi_value SetLogin(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argument;
  napi_get_cb_info(env, info, &argc, &argument, nullptr, nullptr);
  BOOL enable = NO;
  if (argc != 1 || napi_get_value_bool(env, argument, &enable) != napi_ok) {
    napi_throw_type_error(env, nullptr, "Expected a boolean");
    return nullptr;
  }
  if (@available(macOS 13.0, *)) {
    NSError *error = nil;
    BOOL ok = enable ? [SMAppService.mainAppService registerAndReturnError:&error] : [SMAppService.mainAppService unregisterAndReturnError:&error];
    if (!ok) { Fail(env, error.localizedDescription ?: @"登录项设置失败。"); return nullptr; }
    return BoolValue(env, YES);
  }
  Fail(env, @"This macOS version cannot register a login item.");
  return nullptr;
}

static NSSharingService *airDropService;
static napi_value AirDrop(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value paths;
  napi_get_cb_info(env, info, &argc, &paths, nullptr, nullptr);
  bool array = false; uint32_t count = 0;
  if (argc != 1 || napi_is_array(env, paths, &array) != napi_ok || !array ||
      napi_get_array_length(env, paths, &count) != napi_ok || count == 0 || count > 10000) {
    napi_throw_type_error(env, nullptr, "Expected file paths"); return nullptr;
  }
  NSMutableArray<NSURL *> *items = [NSMutableArray arrayWithCapacity:count];
  for (uint32_t index = 0; index < count; index++) {
    napi_value value; size_t length = 0;
    napi_get_element(env, paths, index, &value);
    if (napi_get_value_string_utf8(env, value, nullptr, 0, &length) != napi_ok || length == 0 || length > 32768) {
      napi_throw_type_error(env, nullptr, "Expected an absolute file path"); return nullptr;
    }
    std::string buffer(length + 1, '\0');
    napi_get_value_string_utf8(env, value, buffer.data(), buffer.size(), &length);
    NSString *path = [[NSString alloc] initWithBytes:buffer.data() length:length encoding:NSUTF8StringEncoding];
    if (!path.isAbsolutePath || buffer.find('\0') < length) {
      napi_throw_type_error(env, nullptr, "Expected an absolute file path"); return nullptr;
    }
    [items addObject:[NSURL fileURLWithPath:path]];
  }
  @try {
    NSSharingService *service = [NSSharingService sharingServiceNamed:NSSharingServiceNameSendViaAirDrop];
    if (!service || ![service canPerformWithItems:items]) { Fail(env, @"当前无法使用隔空投送。请检查无线局域网和蓝牙。"); return nullptr; }
    // Keep the service alive while macOS presents its recipient picker.
    airDropService = service;
    [service performWithItems:items];
  } @catch (NSException *exception) { Fail(env, exception.reason); return nullptr; }
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value appURL, bundleID, loginEnabled, setLogin, airDrop;
  napi_create_function(env, "appURL", NAPI_AUTO_LENGTH, AppURL, nullptr, &appURL);
  napi_create_function(env, "bundleID", NAPI_AUTO_LENGTH, BundleID, nullptr, &bundleID);
  napi_create_function(env, "loginEnabled", NAPI_AUTO_LENGTH, LoginEnabled, nullptr, &loginEnabled);
  napi_create_function(env, "setLogin", NAPI_AUTO_LENGTH, SetLogin, nullptr, &setLogin);
  napi_create_function(env, "airDrop", NAPI_AUTO_LENGTH, AirDrop, nullptr, &airDrop);
  napi_set_named_property(env, exports, "airDrop", airDrop);
  napi_set_named_property(env, exports, "appURL", appURL);
  napi_set_named_property(env, exports, "bundleID", bundleID);
  napi_set_named_property(env, exports, "loginEnabled", loginEnabled);
  napi_set_named_property(env, exports, "setLogin", setLogin);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
