#import <AppKit/AppKit.h>
#include <node_api.h>
#include <string>

static napi_value Text(napi_env env, NSString *value) {
  napi_value result;
  if (!value) { napi_get_null(env, &result); return result; }
  napi_create_string_utf8(env, value.UTF8String, NAPI_AUTO_LENGTH, &result);
  return result;
}

static void Fail(napi_env env, NSString *message) {
  napi_throw_error(env, nullptr, message ? message.UTF8String : "Unknown error");
}

static NSSharingService *airDropService;
static NSArray<NSURL *> *FileURLs(napi_env env, napi_value paths) {
  bool array = false; uint32_t count = 0;
  if (napi_is_array(env, paths, &array) != napi_ok || !array ||
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
  return items;
}
static napi_value AirDrop(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value paths;
  napi_get_cb_info(env, info, &argc, &paths, nullptr, nullptr);
  if (argc != 1) { napi_throw_type_error(env, nullptr, "Expected file paths"); return nullptr; }
  NSArray<NSURL *> *items = FileURLs(env, paths);
  if (!items) return nullptr;
  @try {
    NSSharingService *service = [NSSharingService sharingServiceNamed:NSSharingServiceNameSendViaAirDrop];
    if (!service || ![service canPerformWithItems:items]) { Fail(env, @"当前无法使用隔空投送。请检查无线局域网和蓝牙。"); return nullptr; }
    // Keep the service alive while macOS presents its recipient picker.
    airDropService = service;
    [service performWithItems:items];
  } @catch (NSException *exception) { Fail(env, exception.reason); return nullptr; }
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value ShareServices(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value paths;
  napi_get_cb_info(env, info, &argc, &paths, nullptr, nullptr);
  if (argc != 1) { napi_throw_type_error(env, nullptr, "Expected file paths"); return nullptr; }
  NSArray<NSURL *> *items = FileURLs(env, paths);
  if (!items) return nullptr;
  @try {
    // shortcut: AppKit deprecates enumeration; migrate when it offers a custom-menu replacement.
    NSArray<NSSharingService *> *services = [NSSharingService sharingServicesForItems:items];
    napi_value result; napi_create_array_with_length(env, services.count, &result);
    uint32_t index = 0;
    for (NSSharingService *service in services) {
      // Template images lose their appearance-aware tint when serialized; use the app glyph instead.
      NSBitmapImageRep *image = service.image.isTemplate ? nil : [NSBitmapImageRep imageRepWithData:service.image.TIFFRepresentation];
      NSData *png = [image representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
      NSString *icon = png ? [@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]] : @"";
      napi_value item; napi_create_object(env, &item);
      napi_set_named_property(env, item, "title", Text(env, service.title));
      napi_set_named_property(env, item, "icon", Text(env, icon));
      napi_set_element(env, result, index++, item);
    }
    return result;
  } @catch (NSException *exception) { Fail(env, exception.reason); return nullptr; }
}

static NSSharingService *activeShareService;
static napi_value Share(napi_env env, napi_callback_info info) {
  size_t argc = 2; napi_value args[2];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);
  if (argc != 2) { napi_throw_type_error(env, nullptr, "Expected file paths and a sharing service"); return nullptr; }
  NSArray<NSURL *> *items = FileURLs(env, args[0]);
  if (!items) return nullptr;
  size_t length = 0;
  if (napi_get_value_string_utf8(env, args[1], nullptr, 0, &length) != napi_ok || length == 0 || length > 1024) {
    napi_throw_type_error(env, nullptr, "Expected a sharing service"); return nullptr;
  }
  std::string buffer(length + 1, '\0');
  napi_get_value_string_utf8(env, args[1], buffer.data(), buffer.size(), &length);
  if (buffer.find('\0') < length) { napi_throw_type_error(env, nullptr, "Expected a sharing service"); return nullptr; }
  NSString *title = [[NSString alloc] initWithBytes:buffer.data() length:length encoding:NSUTF8StringEncoding];
  @try {
    NSSharingService *chosen = nil;
    for (NSSharingService *service in [NSSharingService sharingServicesForItems:items]) {
      if (![service.title isEqualToString:title]) continue;
      // Refuse ambiguous or stale choices rather than sending to a different service.
      if (chosen) { Fail(env, @"共享方式已更改，请重新打开共享菜单。"); return nullptr; }
      chosen = service;
    }
    if (!chosen || ![chosen canPerformWithItems:items]) { Fail(env, @"共享方式已更改，请重新打开共享菜单。"); return nullptr; }
    activeShareService = chosen;
    [chosen performWithItems:items];
  } @catch (NSException *exception) { Fail(env, exception.reason); return nullptr; }
  napi_value result; napi_get_undefined(env, &result); return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value airDrop, shareServices, share;
  napi_create_function(env, "airDrop", NAPI_AUTO_LENGTH, AirDrop, nullptr, &airDrop);
  napi_create_function(env, "shareServices", NAPI_AUTO_LENGTH, ShareServices, nullptr, &shareServices);
  napi_create_function(env, "share", NAPI_AUTO_LENGTH, Share, nullptr, &share);
  napi_set_named_property(env, exports, "shareServices", shareServices);
  napi_set_named_property(env, exports, "share", share);
  napi_set_named_property(env, exports, "airDrop", airDrop);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
