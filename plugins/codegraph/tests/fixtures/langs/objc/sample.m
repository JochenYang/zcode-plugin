@import Foundation;
#import "Graph.h"

/// A vertex with outbound edges.
@interface GraphNode : NSObject <GraphObserver>
@property (nonatomic, copy) NSString *label;
- (instancetype)initWithLabel:(NSString *)label;
+ (GraphNode *)nodeWithLabel:(NSString *)label;
- (void)connectTo:(GraphNode *)other;
@end

/// Receives lifecycle events of a graph.
@protocol GraphObserver <NSObject>
- (void)graph:(GraphNode *)node didAddEdge:(GraphNode *)other;
@end

static NSString *Prefix(void) {
    return @"node-";
}

@implementation GraphNode
- (instancetype)initWithLabel:(NSString *)label {
    if (self = [super init]) {
        _label = [Prefix() stringByAppendingString:label];
    }
    return self;
}
+ (GraphNode *)nodeWithLabel:(NSString *)label {
    return [[GraphNode alloc] initWithLabel:label];
}
- (void)connectTo:(GraphNode *)other {
    NSLog(@"%@ -> %@", self.label, other.label);
}
@end
