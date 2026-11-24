-module(broken).

-export([gap/1).

gap( when ->
    {ok, };
gap(X) ->
    X.
