#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#include <node_api.h>

static BOOL available = YES;
static NSArray *captured = @[];
static NSUInteger calls = 0;
static NSString *serviceName;
@interface ExplorerAirDropFixture : NSObject
@end
@implementation ExplorerAirDropFixture
- (BOOL)canPerformWithItems:(NSArray *)items { return available; }
- (void)performWithItems:(NSArray<NSURL *> *)items {
  NSMutableArray *paths = [NSMutableArray array];
  for (NSURL *url in items) [paths addObject:@{ @"path": url.path, @"fileURL": @(url.isFileURL) }];
  captured = paths; calls++;
}
@end
static id Service(id self, SEL command, NSString *name) {
  serviceName = name;
  return (id)[ExplorerAirDropFixture new];
}
static napi_value Snapshot(napi_env env, napi_callback_info info) {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@{ @"service": serviceName ?: @"", @"items": captured, @"calls": @(calls) } options:0 error:nil];
  NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  napi_value result; napi_create_string_utf8(env, json.UTF8String, NAPI_AUTO_LENGTH, &result); return result;
}
static napi_value Available(napi_env env, napi_callback_info info) {
  size_t argc = 1; napi_value value; bool flag = true;
  napi_get_cb_info(env, info, &argc, &value, nullptr, nullptr);
  if (argc != 1 || napi_get_value_bool(env, value, &flag) != napi_ok) { napi_throw_type_error(env, nullptr, "Expected boolean"); return nullptr; }
  available = flag;
  napi_value result; napi_get_undefined(env, &result); return result;
}
static napi_value Init(napi_env env, napi_value exports) {
  method_setImplementation(class_getClassMethod([NSSharingService class], @selector(sharingServiceNamed:)), (IMP)Service);
  napi_value snapshot, setAvailable;
  napi_create_function(env, "snapshot", NAPI_AUTO_LENGTH, Snapshot, nullptr, &snapshot);
  napi_create_function(env, "setAvailable", NAPI_AUTO_LENGTH, Available, nullptr, &setAvailable);
  napi_set_named_property(env, exports, "snapshot", snapshot);
  napi_set_named_property(env, exports, "setAvailable", setAvailable);
  return exports;
}
NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
