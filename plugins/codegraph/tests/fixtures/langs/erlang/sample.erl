%% Vault service keeping per-user balances.
-module(vault).
-behaviour(gen_server).

-export([start_link/0, deposit/2, handle_call/3]).

-import(lists, [sum/1]).
-include_lib("kernel/include/logger.hrl").
-include("vault.hrl").

-define(MAX_FEE, 1).
-record(account, {owner :: binary(), balance = 0 :: integer()}).
-type account() :: #account{}.

%% @doc Starts the vault process.
start_link() ->
    gen_server:start_link({local, ?MODULE}, ?MODULE, [], []).

%% @doc Credits Amount for Owner.
deposit(Owner, Amount) when is_binary(Owner), Amount > 0 ->
    gen_server:call(?MODULE, {deposit, #account{owner = Owner, balance = Amount}});
deposit(_Owner, _Amount) ->
    {error, badarg}.

handle_call({deposit, #account{balance = B}}, _From, State) ->
    Total = sum([B, ?MAX_FEE]),
    {reply, Total, State}.
