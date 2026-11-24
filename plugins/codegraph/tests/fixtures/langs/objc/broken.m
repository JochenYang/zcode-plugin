#import <Foundation/Foundation.h>

@interface Broken : NSObject
- (void)f: {
    return [self ;
@end

@implementation Broken
- (void)g
